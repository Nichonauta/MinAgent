import test from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { createAgentModeState, toolsForMode, executeModeTool, assertModeCommand, modeInputPrompt } from "../src/agent-mode.mjs";
import { layoutInput } from "../src/input-layout.mjs";
import { handleModeKeypress, handlePastedInput, handleModelSelectorKeypress } from "../src/editor.mjs";
import { createOpenAiClient } from "../src/openai.mjs";

const tools = ["read_file", "list_directory", "search_files", "edit_file", "write_file", "delete_file", "delete_directory", "run_terminal", "load_skill", "mcp_read"].map((name) => ({ type: "function", function: { name } }));

test("mode input labels report their visible widths with and without colors", () => {
	for (const [mode, label] of [["build", "Build › "], ["plan", "Plan › "]]) {
		for (const colored of [false, true]) {
			const prompt = modeInputPrompt(mode, colored);
			assert.equal(prompt.width, label.length);
			assert.equal(prompt.text.replace(/[\u0001\u0002]/g, "").replace(/\u001b\[[0-9;]*m/g, ""), label);
			const actual = layoutInput(prompt.text, "draft\nnext", 20);
			const expected = layoutInput(label, "draft\nnext", 20);
			assert.deepEqual(actual.positions, expected.positions);
			assert.deepEqual(actual.rows, expected.rows);
		}
	}
});

test("Plan advertises only local reading and listing; Build retains configured tools", () => {
	assert.deepEqual(toolsForMode(tools, "plan").map((tool) => tool.function.name), ["read_file", "list_directory", "search_files"]);
	assert.equal(toolsForMode(tools, "build"), tools);
});

test("Plan rejects mutations and extensions before callbacks or approval can run", () => {
	let executions = 0;
	for (const name of [...tools.map((tool) => tool.function.name), "unknown"]) {
		if (["read_file", "list_directory", "search_files"].includes(name)) continue;
		assert.throws(() => executeModeTool("plan", name, () => { executions += 1; }), /unavailable in Plan/);
	}
	assert.equal(executions, 0);
	assert.equal(executeModeTool("plan", "read_file", () => "contents"), "contents");
	assert.equal(executeModeTool("plan", "list_directory", () => "entries"), "entries");
	assert.equal(executeModeTool("plan", "search_files", () => "matches"), "matches");
	assert.equal(executeModeTool("build", "write_file", () => "written"), "written");
});

test("Plan blocks init while keeping session commands available", () => {
	assert.throws(() => assertModeCommand("plan", "init"), /writes AGENTS.md/);
	assert.doesNotThrow(() => assertModeCommand("build", "init"));
	for (const command of ["model", "compact", "new", "exit"]) assert.doesNotThrow(() => assertModeCommand("plan", command));
});

test("queued messages retain submission modes and Tab cannot alter a running turn", () => {
	const state = createAgentModeState();
	assert.equal(state.selected, "build");
	const first = state.capture();
	state.begin(first);
	state.toggle();
	const second = state.capture();
	assert.equal(state.selected, "plan");
	assert.equal(state.effective, "build");
	state.toggle();
	state.end();
	state.begin(second);
	assert.equal(state.effective, "plan");
	assert.equal(state.selected, "build");
	state.end();
	assert.equal(state.running, null);
	assert.equal(state.effective, "build");
});

test("Tab and Shift+Tab switch modes without changing or submitting a readline draft", async () => {
	const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
	const output = new PassThrough(); output.isTTY = true; output.columns = 80;
	const terminal = createInterface({ input, output, terminal: true });
	const answer = terminal.question(modeInputPrompt("build").text); answer.catch(() => {});
	const state = createAgentModeState();
	const paste = {};
	input.prependListener("keypress", (character, key) => {
		if (handlePastedInput(key, character, terminal, paste)) return;
		if (handleModeKeypress(key)) {
			state.toggle();
			terminal.setPrompt(modeInputPrompt(state.selected).text);
		}
	});
	try {
		input.write("draft"); input.write("\u001b[D");
		const cursor = terminal.cursor;
		input.write("\t");
		assert.equal(state.selected, "plan");
		assert.equal(terminal.getPrompt(), "Plan › ");
		assert.equal(terminal.line, "draft");
		assert.equal(terminal.cursor, cursor);
		input.write("\u001b[Z");
		assert.equal(state.selected, "build");
		assert.equal(terminal.getPrompt(), "Build › ");
		assert.equal(terminal.line, "draft");
		input.write("\r");
		assert.equal(await answer, "draft");
	} finally { terminal.close(); }
	assert.equal(handleModeKeypress({ name: "tab", ctrl: true }), false);
});

test("bracketed pasted tabs remain in the draft without switching modes", async () => {
	const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
	const output = new PassThrough(); output.isTTY = true; output.columns = 80;
	const terminal = createInterface({ input, output, terminal: true });
	const answer = terminal.question("You › "); answer.catch(() => {});
	const state = createAgentModeState();
	const paste = {};
	input.prependListener("keypress", (character, key) => {
		if (handlePastedInput(key, character, terminal, paste)) return;
		if (handleModeKeypress(key)) state.toggle();
	});
	try {
		input.write("\u001b[200~a\tb\u001b[201~");
		assert.equal(terminal.line, "a\tb");
		assert.equal(state.selected, "build");
		input.write("\r");
		assert.equal(await answer, "a\tb");
	} finally { terminal.close(); }
});

test("paste and model selector capture Tab before the mode shortcut", () => {
	const state = createAgentModeState();
	const key = { name: "tab", sequence: "\t" };
	const terminal = { line: "", cursor: 0, prompt() {} };
	const paste = { active: true };
	if (!handlePastedInput(key, "\t", terminal, paste) && handleModeKeypress(key)) state.toggle();
	assert.equal(state.selected, "build");
	const selectorKey = { name: "tab", sequence: "\t" };
	assert.equal(handleModelSelectorKeypress({ candidates: [{ value: "model" }], selectedIndex: 0 }, selectorKey).kind, "ignored");
	assert.equal(handleModeKeypress(selectorKey), false);
});

test("completion requests send the mode catalog without changing shared history", async (t) => {
	const sent = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		sent.push(JSON.parse(body));
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	const client = createOpenAiClient({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "model", tools });
	const messages = [{ role: "user", content: "analyze" }];
	for (const mode of ["plan", "build"]) await client.complete(messages, { withTools: true, availableTools: toolsForMode(tools, mode) });
	assert.deepEqual(sent[0].tools.map((tool) => tool.function.name), ["read_file", "list_directory", "search_files"]);
	assert.deepEqual(sent[1].tools, tools);
	assert.deepEqual(sent[0].messages, sent[1].messages);
});
