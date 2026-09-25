import test from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createWorkspaceAccess } from "../src/workspace.mjs";
import { parseDirectoryEntryLimit } from "../src/config.mjs";
import { collectProjectEssentials } from "../src/init-project.mjs";
import { createFileChangeTracker } from "../src/tool-state.mjs";
import { readStreamingResponse } from "../src/openai.mjs";
import { chunkSummaryTranscript } from "../src/context.mjs";
import { approvalPreview } from "../src/secrets.mjs";
import { runTerminalCommand } from "../src/terminal-command.mjs";
import { createTerminalRendering } from "../src/markdown-terminal.mjs";
import { prepareUserMessage } from "../src/attachments.mjs";
import { AUTOCOMPLETE_PANEL_ROWS, buildAutocompleteState, formatAutocompletePanel, handleAutocompleteKeypress, handleControlJInput, handlePastedInput } from "../src/editor.mjs";
import { terminalTextWidth, truncateTerminalText } from "../src/terminal-text.mjs";
import { executeSkillTool } from "../src/skills.mjs";

async function temporaryWorkspace(t) {
	const root = await mkdtemp(join(tmpdir(), "minagent-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function streamingResponse(events) {
	const encoder = new TextEncoder();
	return {
		body: new ReadableStream({
			start(controller) {
				for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
	};
}

test("read_file can continue within a long Unicode line", async (t) => {
	const root = await temporaryWorkspace(t);
	const content = "😀abc".repeat(12_000);
	await writeFile(join(root, "long.txt"), content);
	const access = createWorkspaceAccess(root, "test");
	let column = 1;
	let collected = "";
	let requests = 0;
	while (true) {
		const output = await access.readFile({ path: "long.txt", offset: 1, column });
		const marker = output.match(/\n\n\[Read stopped at the output limit\. Continue with offset=1, column=(\d+)\.\]$/);
		collected += marker ? output.slice(0, marker.index) : output;
		requests += 1;
		if (!marker) break;
		column = Number(marker[1]);
		assert.ok(requests < 10);
	}
	assert.ok(requests > 1);
	assert.equal(collected, content);
});

test("inventory excludes generated directories and obeys the listing limit", async (t) => {
	const root = await temporaryWorkspace(t);
	for (const directory of [".git", "node_modules", "src"]) await mkdir(join(root, directory));
	await writeFile(join(root, ".git", "secret"), "x");
	await writeFile(join(root, "node_modules", "package.js"), "x");
	await writeFile(join(root, "src", "main.mjs"), "x");
	const complete = await createWorkspaceAccess(root, "test").refreshInventory();
	assert.deepEqual(complete.files, ["src/main.mjs"]);
	const empty = await createWorkspaceAccess(root, "test", 0).refreshInventory();
	assert.deepEqual(empty.files, []);
});

test("disabled inventory still loads AGENTS.md and permits a one-time full listing", async (t) => {
	const root = await temporaryWorkspace(t);
	await writeFile(join(root, "AGENTS.md"), "Project guidance");
	await writeFile(join(root, "README.md"), "Project");
	assert.equal(parseDirectoryEntryLimit(undefined), 0);
	const access = createWorkspaceAccess(root, "test", 0);
	const normal = await access.refreshInventory();
	assert.equal(normal.snapshot, "");
	assert.deepEqual(normal.files, []);
	assert.match(normal.agentsContext, /Project guidance/);
	const forInit = await access.refreshInventory({ includeSnapshot: true, listLimitOverride: -1 });
	assert.match(forInit.snapshot, /\[FILE\] README\.md/);
	assert.ok(forInit.files.includes("README.md"));
});

test("oversized AGENTS.md is omitted from model guidance", async (t) => {
	const root = await temporaryWorkspace(t);
	await writeFile(join(root, "AGENTS.md"), "a".repeat(70_000));
	const inventory = await createWorkspaceAccess(root, "test").refreshInventory();
	assert.match(inventory.agentsContext, /exceeds the .* byte limit/);
	assert.equal(inventory.agentsContent, "");
});

test("workspace rejects hard links", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "workspace");
	await mkdir(root);
	const outside = join(parent, "outside.txt");
	await writeFile(outside, "outside");
	await link(outside, join(root, "hard.txt"));
	const access = createWorkspaceAccess(root, "test");
	await assert.rejects(access.readFile({ path: "hard.txt" }), /Hard-linked/);
});

test("workspace rejects file symbolic links", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "workspace");
	await mkdir(root);
	const outside = join(parent, "outside.txt");
	await writeFile(outside, "outside");
	try {
		await symlink(outside, join(root, "soft.txt"), "file");
	} catch (error) {
		if (["EPERM", "ENOSYS", "EACCES"].includes(error.code)) return t.skip("Symbolic links are unavailable on this host.");
		throw error;
	}
	const access = createWorkspaceAccess(root, "test");
	await assert.rejects(access.readFile({ path: "soft.txt" }), /Symbolic links/);
});

test("workspace rejects directory junctions", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "workspace");
	const outside = join(parent, "outside");
	await mkdir(root);
	await mkdir(outside);
	await writeFile(join(outside, "file.txt"), "outside");
	try {
		await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EPERM", "ENOSYS", "EACCES"].includes(error.code)) return t.skip("Directory links are unavailable on this host.");
		throw error;
	}
	const access = createWorkspaceAccess(root, "test");
	await assert.rejects(access.readFile({ path: "linked/file.txt" }), /Symbolic links/);
	await assert.rejects(access.writeFile({ path: "linked/new.txt", content: "x" }), /Symbolic links/);
	await assert.rejects(access.listDirectory({ path: "linked" }), /Symbolic links/);
});

test("list_directory includes hidden entries without recursing and enforces bounds", async (t) => {
	const root = await temporaryWorkspace(t);
	await mkdir(join(root, "child"));
	await writeFile(join(root, ".hidden"), "hidden");
	await writeFile(join(root, "child", "nested.txt"), "nested");
	const access = createWorkspaceAccess(root, "test");
	const listing = await access.listDirectory();
	assert.match(listing.toolText, /\[FILE\] \.hidden/);
	assert.match(listing.toolText, /\[DIR\] child\//);
	assert.doesNotMatch(listing.toolText, /nested\.txt/);
	const limited = await access.listDirectory({ limit: 1 });
	assert.match(limited.toolText, /Call list_directory with a larger limit/);
	await assert.rejects(access.listDirectory({ path: ".hidden" }), /requires a directory/);
	await assert.rejects(access.listDirectory({ path: ".." }), /outside the current workspace/);
});

test("file tools accept a redundant workspace directory prefix", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "Test");
	await mkdir(root);
	await writeFile(join(root, "note.txt"), "one");
	const access = createWorkspaceAccess(root, "Test");
	assert.equal(access.resolvePath("Test/note.txt"), join(root, "note.txt"));
	if (process.platform === "win32") assert.equal(access.resolvePath("test\\note.txt"), join(root, "note.txt"));
	assert.equal(await access.readFile({ path: "Test/note.txt" }), "one");
	await access.editFile({ path: "Test/note.txt", old_text: "one", new_text: "two" });
	assert.equal(await readFile(join(root, "note.txt"), "utf8"), "two");
	await access.writeFile({ path: "Test/nested/new.txt", content: "new" });
	assert.equal(await readFile(join(root, "nested", "new.txt"), "utf8"), "new");
	await access.deleteFile({ path: "Test/note.txt" });
	await access.deleteDirectory({ path: "Test/nested" });
	await assert.rejects(readFile(join(root, "note.txt")), { code: "ENOENT" });
	await assert.rejects(readFile(join(root, "nested", "new.txt")), { code: "ENOENT" });
	await assert.rejects(access.readFile({ path: "Test" }), /requires a file path.*workspace directory/);
	await assert.rejects(access.deleteDirectory({ path: "Test" }), /root cannot be deleted/);
	assert.throws(() => access.resolvePath("Test/../../outside.txt"), /outside the current workspace/);
});

test("a real subdirectory named after the workspace keeps its own paths", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "Test");
	await mkdir(join(root, "Test"), { recursive: true });
	await writeFile(join(root, "Test", "note.txt"), "child");
	await writeFile(join(root, "note.txt"), "root");
	const access = createWorkspaceAccess(root, "Test");
	assert.equal(await access.readFile({ path: "Test/note.txt" }), "child");
	assert.equal(await access.readFile({ path: "note.txt" }), "root");
	await access.writeFile({ path: "Test/new.txt", content: "nested" });
	assert.equal(await readFile(join(root, "Test", "new.txt"), "utf8"), "nested");
});

test("an explicitly relative path creates a same-named subdirectory", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "Test");
	await mkdir(root);
	const access = createWorkspaceAccess(root, "Test");
	await access.writeFile({ path: "./Test/new.txt", content: "nested" });
	assert.equal(await readFile(join(root, "Test", "new.txt"), "utf8"), "nested");
});

test("a same-named directory junction is never treated as a redundant prefix", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "Test");
	const outside = join(parent, "outside");
	await mkdir(root);
	await mkdir(outside);
	await writeFile(join(outside, "file.txt"), "outside");
	try {
		await symlink(outside, join(root, "Test"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EPERM", "ENOSYS", "EACCES"].includes(error.code)) return t.skip("Directory links are unavailable on this host.");
		throw error;
	}
	const access = createWorkspaceAccess(root, "Test");
	await assert.rejects(access.readFile({ path: "Test/file.txt" }), /Symbolic links/);
});

test("write and edit verify their persisted contents", async (t) => {
	const root = await temporaryWorkspace(t);
	const access = createWorkspaceAccess(root, "test");
	await access.writeFile({ path: "nested/example.txt", content: "one" });
	await access.editFile({ path: "nested/example.txt", old_text: "one", new_text: "two" });
	assert.equal(await access.readFile({ path: "nested/example.txt" }), "two");
});

test("deletion stays within a validated subdirectory", async (t) => {
	const root = await temporaryWorkspace(t);
	const access = createWorkspaceAccess(root, "test");
	await access.writeFile({ path: "folder/one.txt", content: "one" });
	await access.writeFile({ path: "keep.txt", content: "keep" });
	await assert.rejects(access.deleteDirectory({ path: "." }), /root cannot be deleted/);
	await access.deleteDirectory({ path: "folder" });
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep");
});

test("project initialization includes source files with unfamiliar names", async (t) => {
	const root = await temporaryWorkspace(t);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "README.md"), "Project");
	await writeFile(join(root, "src", "minagent.mjs"), "export const x = 1;");
	const access = createWorkspaceAccess(root, "test");
	const result = await collectProjectEssentials({ rootDirectory: root, readWorkspaceRaw: access.readRawFile });
	assert.deepEqual(result.files.map((file) => file.path), ["README.md", "src/minagent.mjs"]);
});

test("project initialization prioritizes its entry point within a small context budget", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "MinAgent");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "README.md"), "r".repeat(1000));
	await writeFile(join(root, "src", "alpha.mjs"), "a".repeat(1000));
	await writeFile(join(root, "src", "minagent.mjs"), "m".repeat(1000));
	const access = createWorkspaceAccess(root, "test");
	const result = await collectProjectEssentials({ rootDirectory: root, readWorkspaceRaw: access.readRawFile, maxTotalChars: 1024 });
	assert.ok(result.files.some((file) => file.path === "src/minagent.mjs"));
	assert.ok(result.files.reduce((sum, file) => sum + file.content.length, 0) <= 1024);
});

test("text attachments keep valid UTF-8 at the excerpt boundary", async (t) => {
	const root = await temporaryWorkspace(t);
	await writeFile(join(root, "note.txt"), `${"a".repeat(48 * 1024 - 1)}😀end`);
	const result = await prepareUserMessage("note.txt", ["note.txt"], {
		workspaceAccess: createWorkspaceAccess(root, "test"), inputModalities: ["text"],
	});
	assert.equal(result.events[0].kind, "attached");
	assert.match(result.message.content[0].text, /File content truncated/);
});

test("skill resource reader rejects binary and invalid UTF-8", async (t) => {
	const root = await temporaryWorkspace(t);
	await writeFile(join(root, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
	await writeFile(join(root, "invalid.txt"), Buffer.from([0xff]));
	const skills = [{ name: "demo", directory: root }];
	await assert.rejects(executeSkillTool("read_skill_resource", { name: "demo", path: "binary.txt" }, skills), /binary/);
	await assert.rejects(executeSkillTool("read_skill_resource", { name: "demo", path: "invalid.txt" }, skills));
});

test("failed readback remains pending until a successful read", () => {
	const tracker = createFileChangeTracker("win32");
	tracker.recordToolResult("write_file", { path: "src\\File.mjs" });
	assert.deepEqual(tracker.requiredPaths(), ["src\\File.mjs"]);
	tracker.recordToolResult("read_file", { path: "./src/file.mjs" }, { failed: true });
	assert.equal(tracker.hasPending(), true);
	tracker.recordToolResult("read_file", { path: "./src/file.mjs" });
	assert.equal(tracker.hasPending(), false);
	tracker.requireRead("another.txt");
	assert.deepEqual(tracker.clear(), ["another.txt"]);
	assert.equal(tracker.hasPending(), false);
});

test("readback tracking recognizes redundant workspace prefixes", async (t) => {
	const parent = await temporaryWorkspace(t);
	const root = join(parent, "Test");
	await mkdir(root);
	const access = createWorkspaceAccess(root, "Test");
	const tracker = createFileChangeTracker(process.platform, access.resolvePath);
	tracker.recordToolResult("write_file", { path: "Test/note.txt" });
	tracker.recordToolResult("read_file", { path: "note.txt" });
	assert.equal(tracker.hasPending(), false);
});

test("streaming client rejects a response stopped at the token limit", async () => {
	const response = streamingResponse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]);
	await assert.rejects(readStreamingResponse(response), /output token limit/);
});

test("streaming client rejects incomplete tool calls", async () => {
	const response = streamingResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{" } }] }, finish_reason: "tool_calls" }] }]);
	await assert.rejects(readStreamingResponse(response), /invalid arguments/);
});

test("compaction splits long transcripts into bounded requests", () => {
	const chunks = chunkSummaryTranscript([
		{ role: "user", content: "a".repeat(1000) },
		{ role: "assistant", content: "b".repeat(1000) },
	], 300);
	assert.ok(chunks.length > 2);
	assert.ok(chunks.every((chunk) => chunk.length <= 300));
	assert.match(chunks[0], /^\[user\]/);
});

test("approval preview masks authorization headers", () => {
	const preview = approvalPreview({ headers: { Authorization: "Bearer sensitive", Cookie: "session=sensitive" } });
	assert.doesNotMatch(preview, /sensitive/);
	assert.match(preview, /REDACTED/);
});

test("terminal command requires approval in Ask mode", async (t) => {
	const root = await temporaryWorkspace(t);
	const result = await runTerminalCommand({ command: "echo should-not-run" }, {
		terminalMode: "ask",
		terminalCommandShell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
		rootDirectory: root,
		interactiveTerminal: { question: async () => "n" },
		print() {}, uiPrint() {}, uiText: (value) => value,
	});
	assert.match(result, /Permission denied/);
});

test("editor keeps pasted newlines and Ctrl+J inside the current input", () => {
	const terminal = { line: "ab", cursor: 1, prompt() {}, isCompletionEnabled: true };
	const state = { active: false, bulkInputChunk: false, skipNextLineFeed: false };
	const start = { name: "paste-start" };
	assert.equal(handlePastedInput(start, "", terminal, state), true);
	const pastedReturn = { name: "return" };
	assert.equal(handlePastedInput(pastedReturn, "\r", terminal, state), true);
	assert.equal(terminal.line, "a\nb");
	assert.equal(pastedReturn.name, "j");
	const end = { name: "paste-end" };
	handlePastedInput(end, "", terminal, state);
	const ctrlJ = { name: "j", ctrl: true };
	assert.equal(handleControlJInput(ctrlJ, "\n", terminal), true);
	assert.equal(terminal.line, "a\n\nb");
});

test("slash and file autocomplete panels render without closing the app", () => {
	const commands = [{ name: "compact", description: "Compact conversation history manually" }, { name: "exit", description: "Exit MinAgent" }];
	const commandState = buildAutocompleteState("/", 1, [], commands);
	const commandLines = formatAutocompletePanel(commandState, { columns: 80 });
	assert.equal(commandLines.length, AUTOCOMPLETE_PANEL_ROWS);
	assert.match(commandLines.join("\n"), /\/compact/);
	assert.match(commandLines.join("\n"), /\/exit/);
	const fileState = buildAutocompleteState("@", 1, ["src/very-long-😀-filename.mjs"], commands);
	const fileLines = formatAutocompletePanel(fileState, { columns: 20 });
	assert.equal(fileLines.length, AUTOCOMPLETE_PANEL_ROWS);
	assert.ok(terminalTextWidth(fileLines[1]) <= 20);
	assert.equal(truncateTerminalText("😀abc", 3), "😀…");
});

test("arrow keys select slash and file suggestions; Enter replaces the text in place", async () => {
	const commands = [{ name: "compact", description: "Compact" }, { name: "exit", description: "Exit" }];
	for (const scenario of [
		{ inputText: "/", workspaceFiles: [], expected: "/exit", selectedFile: null },
		{ inputText: "@", workspaceFiles: ["README.md", "src/file.mjs"], expected: "src/file.mjs", selectedFile: "src/file.mjs" },
	]) {
		const input = new PassThrough();
		input.isTTY = true;
		input.setRawMode = () => {};
		const output = new PassThrough();
		output.isTTY = true;
		output.columns = 80;
		const terminal = createInterface({ input, output, terminal: true });
		const answer = terminal.question("You › ");
		answer.catch(() => {});
		try {
			input.write(scenario.inputText);
			let state = buildAutocompleteState(terminal.line, terminal.cursor, scenario.workspaceFiles, commands);
			let completed;
			const pasteState = { active: false, bulkInputChunk: false, skipNextLineFeed: false };
			input.prependListener("keypress", (character, key) => {
				if (handlePastedInput(key, character, terminal, pasteState)) return;
				const action = handleAutocompleteKeypress(state, key, terminal);
				if (action?.kind === "complete") {
					completed = action;
					state = null;
				}
			});
			input.write("\u001b[B");
			assert.equal(state.selectedIndex, 1);
			input.write("\u001b[A");
			assert.equal(state.selectedIndex, 0);
			input.write("\u001b[B");
			input.write("\r");
			assert.equal(terminal.line, scenario.expected);
			assert.equal(completed.selectedFile, scenario.selectedFile);
			input.write("\r");
			assert.equal(await answer, scenario.expected);
		} finally {
			terminal.close();
		}
	}
});

test("autocomplete replaces a whole token when the cursor is in its middle", () => {
	const commands = [{ name: "compact", description: "Compact" }];
	const terminal = { line: "/compXYZ", cursor: 5 };
	const state = buildAutocompleteState(terminal.line, terminal.cursor, [], commands);
	const action = handleAutocompleteKeypress(state, { name: "enter", ctrl: false, meta: false }, terminal);
	assert.equal(action.kind, "complete");
	assert.equal(terminal.line, "/compact");
});

test("streaming bubble keeps joined emoji on one line", () => {
	let output = "";
	const stdout = { columns: 12, write: (value) => { output += value; } };
	const rendering = createTerminalRendering({
		stdout, getUseColor: () => false, UI_COLORS: { assistantBackground: [0, 0, 0] },
		uiText: (value) => value, uiPrint: (value) => { output += `${value}\n`; }, print: (value) => { output += `${value}\n`; },
	});
	const bubble = rendering.createStreamingOutput("Test");
	for (const character of "👨‍👩‍👧‍👦X") bubble.write(character);
	bubble.close();
	assert.ok(output.split("\n").some((line) => line.includes("👨‍👩‍👧‍👦X")));
});

test("interrupted streaming bubble is labelled incomplete", () => {
	let output = "";
	const rendering = createTerminalRendering({
		stdout: { columns: 40, write: (value) => { output += value; } },
		getUseColor: () => false, UI_COLORS: { assistantBackground: [0, 0, 0] },
		uiText: (value) => value, uiPrint: (value) => { output += `${value}\n`; }, print: (value) => { output += `${value}\n`; },
	});
	const bubble = rendering.createStreamingOutput("Test");
	bubble.write("partial");
	bubble.close("incomplete");
	assert.match(output, /incomplete/);
});

test("Markdown table keeps escaped pipes in a single cell", () => {
	let output = "";
	const rendering = createTerminalRendering({
		stdout: { columns: 60, write: (value) => { output += value; } },
		getUseColor: () => false, UI_COLORS: { assistantBackground: [0, 0, 0] },
		uiText: (value) => value, uiPrint: (value) => { output += `${value}\n`; }, print: (value) => { output += `${value}\n`; },
	});
	const bubble = rendering.createStreamingOutput("Test");
	bubble.write("| A\\|B | C |\n| --- | --- |\n| x | y |");
	bubble.close();
	assert.match(output, /A\|B/);
});
