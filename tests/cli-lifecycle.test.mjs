import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function cli(t, env = {}, { cancelSearch = false, files = {}, appFiles = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), "minagent-cli-"));
	const populate = async (directory, entries) => {
		for (const [name, content] of Object.entries(entries)) {
			const path = join(directory, name);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
		}
	};
	await populate(root, files);
	let entrypoint = new URL("../src/minagent.mjs", import.meta.url).href;
	if (Object.keys(appFiles).length > 0) {
		const installation = join(root, "installation");
		await cp(fileURLToPath(new URL("../src", import.meta.url)), join(installation, "src"), { recursive: true });
		await populate(installation, appFiles);
		entrypoint = pathToFileURL(join(installation, "src/minagent.mjs")).href;
	}
	// Real readline and application code, with terminal capabilities on local pipes.
	const driver = `import { stdin, stdout } from "node:process";
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdout.isTTY = true;
stdout.columns = 80;
stdout.rows = 24;
if (${cancelSearch}) {
 const write = stdout.write.bind(stdout);
 let canceled = false;
 stdout.write = (value, ...args) => {
  const result = write(value, ...args);
  // Deliver Esc at the first search yield, without a timing race across processes.
  if (!canceled && String(value).includes("Searching…")) {
   canceled = true;
   setImmediate(() => stdin.emit("keypress", "\\u001b", { name: "escape", ctrl: false, meta: true }));
  }
  return result;
 };
}
await import(${JSON.stringify(entrypoint)});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
		cwd: root, windowsHide: true,
		env: { ...process.env, OPENAI_MODEL: "lifecycle-test", OPENAI_API_KEY: "lifecycle-test", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", MCP_MODE: "off", SKILLS_MODE: "off", TERMINAL_MODE: "off", NO_COLOR: "1", ...env },
	});
	let output = "", errors = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
		await rm(root, { recursive: true, force: true });
	});
	const waitFor = (text, since = 0) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Missing CLI output: ${text}\n${errors}\n${output.slice(since).slice(-1500)}`)), 2000);
		const finish = (error) => {
			clearTimeout(timer);
			child.stdout.removeListener("data", check);
			if (error) reject(error); else resolve();
		};
		const check = () => { if (output.slice(since).includes(text)) finish(); };
		child.stdout.on("data", check);
		check();
	});
	await waitFor("Build › ");
	return { root, child, waitFor, exited, output: () => output, errors: () => errors };
}

async function listen(t, server) {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	return `http://127.0.0.1:${server.address().port}`;
}

async function chatFixture(t, respond) {
	const requests = [];
	const url = await listen(t, createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body);
		requests.push(payload);
		const delta = respond(payload, requests.length);
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
	}));
	return { url: `${url}/v1`, requests };
}

function toolCall(name, args, index) {
	return { tool_calls: [{ index: 0, id: `extension-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

async function submit(app, text) {
	const since = app.output().length;
	app.child.stdin.write(text);
	await app.waitFor(`Build › ${text}`, since);
	app.child.stdin.write("\r");
	return since;
}

async function exit(app) {
	await submit(app, "/exit");
	assert.deepEqual(await app.exited, { code: 0, signal: null });
	assert.equal(app.errors(), "");
}

for (const { mode, answer } of [{ mode: "auto" }, { mode: "ask", answer: "y" }, { mode: "ask", answer: "n" }, { mode: "off" }]) {
	test(`CLI MCP ${mode}${answer ? ` (${answer})` : ""} controls discovery and every call`, { timeout: 10000 }, async (t) => {
		const mcpRequests = [], calls = [];
		const mcpUrl = await listen(t, createServer(async (request, response) => {
			if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
			let body = "";
			for await (const chunk of request) body += chunk;
			const call = JSON.parse(body);
			mcpRequests.push(call.method);
			if (call.id === undefined) { response.writeHead(202); response.end(); return; }
			let result;
			if (call.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" }, instructions: "MCP_FIXTURE_GUIDANCE" };
			else if (call.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
			else if (call.method === "tools/call") {
				calls.push(call.params.arguments);
				result = { content: [{ type: "text", text: call.params.arguments.text }] };
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
		}));
		const chat = await chatFixture(t, (payload, round) => {
			const tool = payload.tools.find((entry) => entry.function.name.startsWith("mcp_"));
			return tool && round <= 2 ? toolCall(tool.function.name, { text: `MCP_RESULT_${round}` }, round) : { content: "Finished MCP fixture." };
		});
		const app = await cli(t, { OPENAI_BASE_URL: chat.url, MCP_MODE: mode }, {
			appFiles: { ".minagent/mcp.json": JSON.stringify({ mcpServers: { fixture: { url: `${mcpUrl}/mcp` } } }) },
		});
		const since = await submit(app, "Use MCP twice.");
		if (mode === "ask") {
			let sinceApproval = since;
			for (let round = 1; round <= (answer === "y" ? 2 : 1); round += 1) {
				await app.waitFor("MCP permission requested", sinceApproval);
				await app.waitFor("Allow this MCP call? [y/N]", sinceApproval);
				assert.equal(calls.length, round - 1, "the pending MCP call has not executed");
				assert.equal(chat.requests.length, round);
				const sinceAnswer = app.output().length;
				app.child.stdin.write(answer);
				await app.waitFor(`Allow this MCP call? [y/N] ${answer}`, sinceAnswer);
				sinceApproval = app.output().length;
				app.child.stdin.write("\r");
			}
		}
		await app.waitFor(answer === "n" ? "No tool was executed." : "╰─ complete", since);
		if (mode === "off") {
			assert.deepEqual(mcpRequests, []);
			assert.ok(!chat.requests[0].tools.some((tool) => tool.function.name.startsWith("mcp_")));
			assert.doesNotMatch(chat.requests[0].messages[0].content, /MCP_FIXTURE_GUIDANCE/);
		} else {
			assert.ok(mcpRequests.includes("initialize"));
			assert.match(chat.requests[0].messages[0].content, new RegExp(`MCP: ${mode}`));
		}
		const allowed = mode !== "off" && answer !== "n";
		assert.deepEqual(calls, allowed ? [{ text: "MCP_RESULT_1" }, { text: "MCP_RESULT_2" }] : []);
		assert.equal(chat.requests.length, allowed ? 3 : 1);
		if (allowed) assert.match(chat.requests[2].messages.find((message) => message.tool_call_id === "extension-2").content, /MCP_RESULT_2/);
		if (mode !== "ask") assert.doesNotMatch(app.output().slice(since), /MCP permission requested|Allow this MCP call/);
		await exit(app);
	});

	test(`CLI skills ${mode}${answer ? ` (${answer})` : ""} controls instruction and resource loads`, { timeout: 10000 }, async (t) => {
		const chat = await chatFixture(t, (payload, round) => {
			const enabled = payload.tools.some((entry) => entry.function.name === "load_skill");
			return enabled && round <= 2 ? toolCall("load_skill", { name: "demo", ...(round === 2 ? { path: "reference.txt" } : {}) }, round) : { content: "Finished skills fixture." };
		});
		const app = await cli(t, { OPENAI_BASE_URL: chat.url, SKILLS_MODE: mode }, {
			files: {
				".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: SKILL_FIXTURE_DESCRIPTION\n---\nHIDDEN_SKILL_INSTRUCTIONS",
				".agents/skills/demo/reference.txt": "HIDDEN_SKILL_RESOURCE",
			},
		});
		const since = await submit(app, "Load demo and its resource.");
		if (mode === "ask") {
			let sinceApproval = since;
			for (let round = 1; round <= (answer === "y" ? 2 : 1); round += 1) {
				await app.waitFor("Skills permission requested", sinceApproval);
				await app.waitFor("Allow this skill load? [y/N]", sinceApproval);
				assert.equal(chat.requests.length, round, "the pending skill load has not reached the model");
				assert.doesNotMatch(JSON.stringify(chat.requests), new RegExp(round === 1 ? "HIDDEN_SKILL_INSTRUCTIONS" : "HIDDEN_SKILL_RESOURCE"));
				const sinceAnswer = app.output().length;
				app.child.stdin.write(answer);
				await app.waitFor(`Allow this skill load? [y/N] ${answer}`, sinceAnswer);
				sinceApproval = app.output().length;
				app.child.stdin.write("\r");
			}
		}
		await app.waitFor(answer === "n" ? "No tool was executed." : "╰─ complete", since);
		const allowed = mode !== "off" && answer !== "n";
		assert.equal(chat.requests.length, allowed ? 3 : 1);
		assert.doesNotMatch(JSON.stringify(chat.requests[0].messages), /HIDDEN_SKILL_INSTRUCTIONS|HIDDEN_SKILL_RESOURCE/);
		if (allowed) {
			const results = chat.requests[2].messages.filter((message) => message.role === "tool");
			assert.match(results[0].content, /HIDDEN_SKILL_INSTRUCTIONS/);
			assert.match(results[1].content, /HIDDEN_SKILL_RESOURCE/);
		} else assert.doesNotMatch(JSON.stringify(chat.requests), /HIDDEN_SKILL_INSTRUCTIONS|HIDDEN_SKILL_RESOURCE/);
		if (mode === "off") {
			assert.ok(!chat.requests[0].tools.some((tool) => tool.function.name === "load_skill"));
			assert.doesNotMatch(chat.requests[0].messages[0].content, /SKILL_FIXTURE_DESCRIPTION/);
		} else assert.match(chat.requests[0].messages[0].content, new RegExp(`Skills: ${mode}`));
		if (mode !== "ask") assert.doesNotMatch(app.output().slice(since), /Skills permission requested|Allow this skill load/);
		await exit(app);
	});
}

test("CLI file autocomplete attaches selected files without automatic directory context", { timeout: 10000 }, async (t) => {
	const chat = await chatFixture(t, () => ({ content: "Read your message." }));
	const app = await cli(t, { OPENAI_BASE_URL: chat.url }, {
		files: { "AGENTS.md": "PROJECT_GUIDANCE_FIXTURE", "src/unique-file.mjs": "ATTACHMENT_FIXTURE", "unselected.txt": "UNSELECTED_CONTENT" },
	});
	let since = await submit(app, "Hello.");
	await app.waitFor("╰─ complete", since);
	assert.match(chat.requests[0].messages[0].content, /PROJECT_GUIDANCE_FIXTURE/);
	assert.doesNotMatch(JSON.stringify(chat.requests[0].messages), /unique-file|unselected|ATTACHMENT_FIXTURE|UNSELECTED_CONTENT/);
	since = app.output().length;
	app.child.stdin.write("@uniqu");
	await app.waitFor("Build › @uniqu", since);
	app.child.stdin.write("e");
	await app.waitFor("┌─ FILES", since);
	app.child.stdin.write("\r");
	await app.waitFor("Build › src/unique-file.mjs", since);
	app.child.stdin.write("\r");
	await app.waitFor("╰─ complete", since);
	assert.equal(chat.requests.length, 2);
	assert.doesNotMatch(chat.requests[1].messages[0].content, /unselected|ATTACHMENT_FIXTURE|UNSELECTED_CONTENT/);
	const attachedMessage = chat.requests[1].messages.at(-1);
	assert.equal(attachedMessage.role, "user");
	assert.match(JSON.stringify(attachedMessage.content), /src\/unique-file\.mjs/);
	assert.match(JSON.stringify(attachedMessage.content), /ATTACHMENT_FIXTURE/);
	assert.doesNotMatch(JSON.stringify(attachedMessage.content), /UNSELECTED_CONTENT/);
	await exit(app);
});

test("CLI uses full read and search defaults and executes several changes in one response", { timeout: 10000 }, async (t) => {
	const requests = [];
	const entries = [
		["read_file", { path: "notes.txt" }],
		["search_files", { query: "needle", mode: "content" }],
		...Array.from({ length: 4 }, (_, index) => ["write_file", { path: `generated-${index}.txt`, content: `created ${index}` }]),
	];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push(JSON.parse(body));
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = requests.length === 1
			? { tool_calls: entries.map(([name, args], index) => ({ index, id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
			: { content: "Completed inspection and file creation." };
		response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	const app = await cli(t, { OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_CONTEXT_WINDOW: "262144" }, {
		files: { "notes.txt": Array.from({ length: 260 }, (_, index) => `line ${index + 1} needle`).join("\n") },
	});
	app.child.stdin.write("Inspect notes, search needle and create four files.");
	await app.waitFor("Build › Inspect notes");
	app.child.stdin.write("\r");
	await app.waitFor("╰─ complete");
	assert.equal(requests.length, 2);
	assert.equal(requests[0].max_tokens, undefined);
	const results = requests[1].messages.filter((message) => message.role === "tool");
	assert.equal(results.length, 6);
	const metadata = results.map((result) => JSON.parse(result.content.split("\n")[0].slice(13)));
	assert.equal(metadata[0].read.requestedLimit, 300);
	assert.equal(metadata[0].read.returnedLines, 260);
	assert.equal(metadata[0].read.reachedEndOfFile, true);
	assert.equal(metadata[1].search.returnedResults, 100);
	assert.ok(metadata.slice(2).every((result) => result.status === "success" && result.changed === true));
	for (let index = 0; index < 4; index += 1) assert.equal(await readFile(join(app.root, `generated-${index}.txt`), "utf8"), `created ${index}`);
	app.child.stdin.write("/exit");
	await app.waitFor("Build › /exit");
	app.child.stdin.write("\r");
	assert.deepEqual(await app.exited, { code: 0, signal: null });
	assert.equal(app.errors(), "");
});

test("CLI clears hidden autocomplete on model selection and keeps mode and command input working", { timeout: 10000 }, async (t) => {
	let sendCatalog;
	const requested = new Promise((resolve) => { sendCatalog = resolve; });
	const server = createServer((request, response) => {
		assert.equal(request.url, "/v1/models");
		sendCatalog(() => response.end(JSON.stringify({ data: [{ id: "lifecycle-test" }, { id: "other-model" }] })));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	const app = await cli(t, { OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
	app.child.stdin.write("/model");
	await app.waitFor("Build › /model");
	app.child.stdin.write("\r");
	const respond = await requested;
	let since = app.output().length;
	app.child.stdin.write("/");
	await app.waitFor("┌─ COMMANDS", since);
	since = app.output().length;
	respond();
	await app.waitFor("┌─ MODELS", since);
	since = app.output().length;
	app.child.stdin.write("\u001b");
	await app.waitFor("Ready", since);
	since = app.output().length;
	app.child.stdin.write("\r");
	await app.waitFor("╭─ COMMANDS", since);
	assert.doesNotMatch(app.output().slice(since), /New conversation ready/);
	since = app.output().length;
	app.child.stdin.write("\t");
	await app.waitFor("Plan › ", since);
	since = app.output().length;
	app.child.stdin.write("/");
	await app.waitFor("Plan › /", since);
	since = app.output().length;
	app.child.stdin.write("n");
	await app.waitFor("Plan › /n", since);
	await app.waitFor("┌─ COMMANDS", since);
	app.child.stdin.write("\r");
	await app.waitFor("Plan › /new", since);
	app.child.stdin.write("\r");
	await app.waitFor("New conversation ready", since);
	since = app.output().length;
	app.child.stdin.write("/exit");
	await app.waitFor("Plan › /exit", since);
	app.child.stdin.write("\r");
	assert.deepEqual(await app.exited, { code: 0, signal: null });
	assert.equal(app.errors(), "");
});

test("CLI cancellation pairs every pending tool call and permits the next message", { timeout: 10000 }, async (t) => {
	let resolveResumed;
	const resumed = new Promise((resolve) => { resolveResumed = resolve; });
	let requests = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body);
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		if (requests++ === 0) {
			const toolCalls = [
				{ index: 0, id: "search-call", type: "function", function: { name: "search_files", arguments: '{"query":"needle","mode":"content"}' } },
				{ index: 1, id: "pending-read", type: "function", function: { name: "read_file", arguments: '{"path":"must-not-be-read.txt"}' } },
			];
			response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
		} else {
			resolveResumed(payload);
			response.end('data: {"choices":[{"delta":{"content":"Continued"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	const app = await cli(t, { OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }, { cancelSearch: true });
	app.child.stdin.write("inspect");
	await app.waitFor("Build › inspect");
	app.child.stdin.write("\r");
	await app.waitFor("Response stopped. You can send a new message.");
	await app.waitFor("Ready", app.output().indexOf("Response stopped."));
	const sinceResuming = app.output().length;
	app.child.stdin.write("continue");
	await app.waitFor("Build › continue");
	app.child.stdin.write("\r");
	const payload = await resumed;
	const results = payload.messages.filter((message) => message.role === "tool");
	assert.deepEqual(results.map((message) => message.tool_call_id), ["search-call", "pending-read"]);
	assert.match(results[0].content, /"status":"canceled"/);
	assert.match(results[1].content, /canceled before execution/);
	await app.waitFor("╰─ complete", sinceResuming);
	assert.match(app.output().slice(sinceResuming).replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/g, ""), /Continued/);
	app.child.stdin.write("/exit");
	await app.waitFor("Build › /exit");
	app.child.stdin.write("\r");
	assert.deepEqual(await app.exited, { code: 0, signal: null });
	assert.equal(app.errors(), "");
});

for (const action of ["/exit", "Ctrl+C"]) {
	test(`CLI ${action} settles its input and restores the terminal on exit`, { timeout: 5000 }, async (t) => {
		const app = await cli(t);
		if (action === "/exit") {
			app.child.stdin.write("/exit");
			await app.waitFor("Build › /exit");
			app.child.stdin.write("\r");
		} else {
			app.child.stdin.write("draft");
			await app.waitFor("Build › draft");
			app.child.stdin.write("\u0003");
			await app.waitFor("\u001b[?2004l");
			// Release the simulated input pipe after the application handles SIGINT.
			app.child.stdin.end();
		}
		assert.deepEqual(await app.exited, { code: 0, signal: null });
		assert.doesNotMatch(app.errors(), /unsettled top-level await/);
		assert.ok(app.output().includes("\u001b[?2004l"), "bracketed paste disabled");
		assert.ok(app.output().includes("\u001b[r"), "scroll region restored");
	});
}
