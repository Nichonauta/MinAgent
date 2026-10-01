import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceAccess } from "../src/workspace.mjs";
import { investigateAndInitialize } from "../src/init-project.mjs";
import { INIT_PROMPT, INIT_RESEARCH_PROMPT } from "../src/prompts.mjs";

const tools = ["list_directory", "read_file", "write_file", "run_terminal", "mcp_example"].map((name) => ({ type: "function", function: { name } }));
const calls = (...entries) => ({ message: { content: "Inspect the important sources.", tool_calls: entries.map(([name, args], index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } });
const answer = (content) => ({ message: { content } });

async function fixture(t, entries = {}) {
	const root = await mkdtemp(join(tmpdir(), "minagent-init-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(entries)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return createWorkspaceAccess(root, "test");
}

function options(workspace, responses, extra = {}) {
	let index = 0;
	return {
		workspace, workspaceName: "test", tools,
		complete: async () => {
			assert.ok(index < responses.length, "unexpected extra model request");
			return responses[index++];
		},
		...extra,
	};
}

test("init lists, explores unfamiliar deep folders, reads ranges, then generates and saves", async (t) => {
	const workspace = await fixture(t, { "README.md": "Run node app.mjs", "custom/nested/app.mjs": "first\nsecond\nthird" });
	const events = [];
	const responses = [
		calls(["read_file", { path: "README.md" }], ["list_directory", { path: "custom" }]),
		calls(["list_directory", { path: "custom/nested" }]),
		calls(["read_file", { path: "custom/nested/app.mjs", limit: 1 }]),
		calls(["read_file", { path: "custom/nested/app.mjs", offset: 2 }]),
		answer("Entrypoint: custom/nested/app.mjs. README documents the command."),
		answer("# Repository Guidelines\n\nRun `node app.mjs`."),
	];
	let index = 0;
	const result = await investigateAndInitialize(options(workspace, [], {
		onToolStart: (name, args) => events.push(`start:${name}:${args.path}`),
		onToolFinish: (name, args, result) => events.push(`finish:${name}:${args.path}:${Boolean(result.isError)}`),
		complete: async (messages, opts) => {
			if (index < responses.length - 1) {
				assert.equal(messages[0].content, INIT_RESEARCH_PROMPT);
				assert.deepEqual(opts.availableTools.map((tool) => tool.function.name), ["list_directory", "read_file"]);
			} else {
				assert.equal(messages[0].content, INIT_PROMPT);
				assert.ok(!opts.withTools);
				assert.ok(messages.some((message) => message.role === "tool" && message.content.includes("second")));
			}
			return responses[index++];
		},
	}));
	assert.equal(result.action, "created");
	assert.equal(result.inspectedFiles, 2);
	assert.equal(events[0], "start:list_directory:.");
	assert.equal(events[1], "finish:list_directory:.:false");
	assert.ok(result.evidence.some((entry) => entry.read?.nextOffset === 2));
	assert.match(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), /Repository Guidelines/);
});

test("premature completion is corrected once and cannot overwrite existing instructions", async (t) => {
	const workspace = await fixture(t, { "README.md": "important", "AGENTS.md": "Original rules" });
	await assert.rejects(investigateAndInitialize(options(workspace, [answer("Ready"), answer("Ready")])), /incomplete/);
	assert.equal(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), "Original rules");
});

test("failed file reads remain visible and prevent evidence-free generation", async (t) => {
	const workspace = await fixture(t, { "README.md": "important" });
	workspace.readFileDetailed = async () => { throw new Error("Access denied"); };
	const failures = [];
	await assert.rejects(investigateAndInitialize(options(workspace, [calls(["read_file", { path: "README.md" }]), answer("Ready"), answer("Ready")], { onToolFinish: (_name, _args, result) => { if (result.isError) failures.push(result.toolText); } })), /incomplete/);
	assert.deepEqual(failures, ["Error: Access denied"]);
	assert.equal(await workspace.fileState("AGENTS.md"), null);
});

test("investigation rejects writes, outside paths, credentials, and extensions", async (t) => {
	const workspace = await fixture(t, { "README.md": "facts", ".env": "secret" });
	const errors = [];
	await investigateAndInitialize(options(workspace, [
		calls(["write_file", { path: "evil.md", content: "evil" }], ["run_terminal", { command: "evil" }], ["mcp_example", {}], ["read_file", { path: "../outside.md" }], ["read_file", { path: ".env" }], ["read_file", { path: "README.md" }]),
		answer("README facts"), answer("# Guide\nVerified facts"),
	], { onToolFinish: (_name, _args, result) => { if (result.isError) errors.push(result.toolText); } }));
	assert.equal(errors.length, 5);
	assert.equal(await workspace.fileState("evil.md"), null);
});

test("existing AGENTS.md is supplied intact and external edits stop replacement", async (t) => {
	const workspace = await fixture(t, { "AGENTS.md": "Keep these instructions", "README.md": "facts" });
	let round = 0;
	await assert.rejects(investigateAndInitialize(options(workspace, [], { complete: async (messages, opts) => {
		if (round++ === 0) {
			assert.ok(messages[1].content.includes("Keep these instructions"));
			return calls(["read_file", { path: "README.md" }]);
		}
		if (opts.withTools) return answer("Confirmed README facts.");
		await writeFile(join(workspace.rootDirectory, "AGENTS.md"), "Edited externally");
		return answer("# Generated replacement");
	} })), /changed during investigation/);
	assert.equal(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), "Edited externally");
});

test("a newly created AGENTS.md is also protected against external changes", async (t) => {
	const workspace = await fixture(t);
	await assert.rejects(investigateAndInitialize(options(workspace, [], { complete: async (_messages, opts) => {
		if (opts.withTools) return answer("The repository is empty.");
		await writeFile(join(workspace.rootDirectory, "AGENTS.md"), "Created externally");
		return answer("# Empty repository guide");
	} })), /changed during investigation/);
});

test("cancellation during investigation or generation leaves the prior file intact", async (t) => {
	for (const phase of ["research", "generation"]) {
		const workspace = await fixture(t, { "AGENTS.md": "Original", "README.md": "facts" });
		const controller = new AbortController();
		let round = 0;
		await assert.rejects(investigateAndInitialize(options(workspace, [], { signal: controller.signal, complete: async (_messages, opts) => {
			if ((phase === "research" && opts.withTools) || (phase === "generation" && !opts.withTools)) { controller.abort(); return answer("unfinished"); }
			return round++ === 0 ? calls(["read_file", { path: "README.md" }]) : answer("facts");
		} })), { name: "AbortError" });
		assert.equal(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), "Original");
	}
});

test("empty repositories get an explicit minimal guide; budget exhaustion never writes", async (t) => {
	const empty = await fixture(t);
	const result = await investigateAndInitialize(options(empty, [answer("Empty repository; no project commands are known."), answer("# Repository Guidelines\nNo project files or commands yet.")]));
	assert.equal(result.inspectedFiles, 0);
	const small = await fixture(t, { "README.md": "large".repeat(500) });
	await assert.rejects(investigateAndInitialize(options(small, [], { maxInputTokens: 1 })), /context budget/);
	assert.equal(await small.fileState("AGENTS.md"), null);
});

test("manifest and representative source evidence cannot be skipped", async (t) => {
	const workspace = await fixture(t, { "README.md": "documentation", "package.json": '{"scripts":{"test":"node --test"}}', "src/main.mjs": "export const app = 1;" });
	await assert.rejects(investigateAndInitialize(options(workspace, [
		calls(["read_file", { path: "README.md" }], ["list_directory", { path: "src" }]),
		answer("Ready"), answer("Ready"),
	])), /package.json; read representative source/);
	assert.equal(await workspace.fileState("AGENTS.md"), null);
});

test("init keeps config read requirements and excludes every generated directory", async (t) => {
	const directories = [".git", ".hg", ".svn", "node_modules", ".next", ".cache", "dist", "BUILD", "coverage"];
	const workspace = await fixture(t, {
		"README.md": "facts", "requirements.txt": "dependency", "vite.config.mjs": "export default {};",
		...Object.fromEntries(directories.map((directory) => [`${directory}/generated.txt`, "generated"])),
	});
	await assert.rejects(investigateAndInitialize(options(workspace, [
		calls(["read_file", { path: "README.md" }]), answer("Ready"), answer("Ready"),
	])), /requirements.txt; vite.config.mjs/);
	const failures = [];
	const result = await investigateAndInitialize(options(workspace, [
		calls(...directories.map((path) => ["list_directory", { path }]),
			["read_file", { path: "README.md" }], ["read_file", { path: "requirements.txt" }], ["read_file", { path: "vite.config.mjs" }]),
		answer("Confirmed files"), answer("# Guide\nConfirmed project files."),
	], { onToolFinish: (_name, _args, result) => { if (result.isError) failures.push(result.toolText); } }));
	assert.equal(result.inspectedFiles, 3);
	assert.equal(failures.length, directories.length);
	assert.ok(failures.every((text) => text.includes("directories are excluded")));
});

test("investigation round limits and malformed generated output prevent saving", async (t) => {
	const workspace = await fixture(t, { "README.md": "documentation" });
	await assert.rejects(investigateAndInitialize(options(workspace, [calls(["read_file", { path: "README.md" }])], { maxRounds: 1 })), /round limit/);
	await assert.rejects(investigateAndInitialize(options(workspace, [calls(["read_file", { path: "README.md" }]), answer("facts"), answer("Sorry, I cannot do that.")])), /no Markdown heading/);
	assert.equal(await workspace.fileState("AGENTS.md"), null);
});

test("cancellation just before commit prevents replacement", async (t) => {
	const workspace = await fixture(t, { "AGENTS.md": "Original", "README.md": "facts" });
	const expectedState = await workspace.fileState("AGENTS.md");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(workspace.writeFile({ path: "AGENTS.md", content: "# Replacement" }, { expectedState, signal: controller.signal }), { name: "AbortError" });
	assert.equal(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), "Original");
});

test("init reports malformed arguments, then recovers and saves a document from text parts", async (t) => {
	const workspace = await fixture(t, { "README.md": "Run node src/main.mjs" });
	const malformed = calls(["read_file", {}], ["read_file", {}]);
	malformed.message.tool_calls[0].function.arguments = "null";
	malformed.message.tool_calls[1].function.arguments = "{";
	const events = [];
	let round = 0;
	const replies = [malformed, calls(["read_file", { path: "README.md" }]), answer("Confirmed README command."), answer([null, { type: "text", text: "# Guide" }, { type: "text", text: "Run node src/main.mjs" }])];
	await investigateAndInitialize(options(workspace, [], {
		onToolFinish: (name, _args, result) => { if (name === "read_file") events.push(result); },
		complete: async (messages) => {
			if (round === 1) {
				const results = messages.filter((message) => message.role === "tool");
				assert.equal(results.length, 2);
				for (const result of results) assert.match(result.content, /"status":"error"/);
			}
			return replies[round++];
		},
	}));
	assert.deepEqual(events.map((result) => Boolean(result.isError)), [true, true, false]);
	assert.equal(await readFile(join(workspace.rootDirectory, "AGENTS.md"), "utf8"), "# Guide\nRun node src/main.mjs\n");
});
