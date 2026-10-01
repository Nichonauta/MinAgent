import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createWorkspaceAccess } from "../src/workspace.mjs";
import { createEvidenceLedger, createLoopGuard, executeRecordedTool, preflightCalls, toolEnvelope, validateToolArguments } from "../src/agent-runtime.mjs";
import { workspaceTools } from "../src/tool-definitions.mjs";
import { toolsForMode, executeModeTool } from "../src/agent-mode.mjs";
import { serializeForSummary, pruneToolHistory } from "../src/context.mjs";
import { createOpenAiClient, readStreamingResponse } from "../src/openai.mjs";

async function fixture(t, content = "first\nsecond\nthird") {
	const root = await mkdtemp(join(tmpdir(), "minagent-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "file.txt"), content);
	const workspace = createWorkspaceAccess(root, "fixture");
	const ledger = createEvidenceLedger(workspace);
	const dispatch = (name, args, guarded) => {
		if (name === "read_file") return workspace.readFileDetailed(args);
		if (name === "edit_file") return workspace.editFile(args, guarded);
		if (name === "write_file") return workspace.writeFile(args, guarded);
		throw new Error("Unexpected tool");
	};
	return { root, workspace, ledger, execute: (name, args, mode = "build") => executeModeTool(mode, name, () => executeRecordedTool(name, args, { ledger, definitions: toolsForMode(workspaceTools, mode), dispatch })) };
}

test("local argument validation rejects unknown keys, types, ranges and unavailable tools", () => {
	for (const [name, args] of [["read_file", { path: "x", offset: "2" }], ["read_file", { path: "x", offset: 0 }], ["write_file", { path: "x" }], ["read_file", { path: "x", invented: true }], ["search_files", { query: "x", mode: "regex" }], ["unknown", {}]]) assert.throws(() => validateToolArguments(name, args, workspaceTools));
});

test("preflight accepts up to sixteen calls including changes and rejects oversized batches", () => {
	const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
	const writes = Array.from({ length: 16 }, (_, index) => call("write_file", { path: `${index}.txt`, content: "generated" }));
	assert.doesNotThrow(() => preflightCalls(writes, workspaceTools));
	assert.throws(() => preflightCalls([...writes, call("read_file", { path: "a" })], workspaceTools), { code: "CALL_LIMIT" });
	assert.doesNotThrow(() => preflightCalls([call("read_file", { path: "a" }), call("read_file", { path: "b" })], workspaceTools));
	for (const value of ["null", "[]", "42", "\"text\"", "{"]) {
		assert.throws(() => preflightCalls([{ function: { name: "read_file", arguments: value } }], workspaceTools));
	}
});

test("unread and uninspected blocks cannot be edited; successful edits update evidence", async (t) => {
	const f = await fixture(t);
	const args = { path: "file.txt", old_text: "second", new_text: "$& updated" };
	await assert.rejects(f.execute("edit_file", args), { code: "READ_REQUIRED" });
	await f.execute("read_file", { path: "file.txt", limit: 1 });
	await assert.rejects(f.execute("edit_file", args), { code: "BLOCK_READ_REQUIRED" });
	await f.execute("read_file", { path: "file.txt", offset: 2, limit: 1 });
	await f.execute("edit_file", args);
	await f.execute("edit_file", { ...args, old_text: "$& updated", new_text: "changed again" });
	assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "first\nchanged again\nthird");
});

test("consecutive partial reads merge to a complete read before full replacement", async (t) => {
	const f = await fixture(t, "a\r\n😀b\r\nc");
	await f.execute("read_file", { path: "file.txt", limit: 1 });
	await assert.rejects(f.execute("write_file", { path: "file.txt", content: "replacement" }), { code: "FULL_READ_REQUIRED" });
	await f.execute("read_file", { path: "file.txt", offset: 3, limit: 1 });
	await f.execute("read_file", { path: "file.txt", offset: 2, limit: 1 });
	await f.execute("write_file", { path: "file.txt", content: "replacement" });
	await f.execute("edit_file", { path: "file.txt", old_text: "replacement", new_text: "$& literal" });
	assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "$& literal");
});

test("external changes invalidate evidence and guard the interval before committing", async (t) => {
	const f = await fixture(t);
	await f.execute("read_file", { path: "file.txt" });
	const args = { path: "file.txt", old_text: "first", new_text: "updated" };
	const guarded = await f.ledger.beforeMutation("edit_file", args);
	await writeFile(join(f.root, "file.txt"), "external change");
	await assert.rejects(f.workspace.editFile(args, guarded), /changed since inspection/);
	await assert.rejects(f.execute("edit_file", args), { code: "READ_REQUIRED" });
	const create = { path: "new.txt", content: "generated" };
	const expected = await f.ledger.beforeMutation("write_file", create);
	await writeFile(join(f.root, "new.txt"), "external");
	await assert.rejects(f.workspace.writeFile(create, expected), /changed during investigation/);
});

test("Unicode long-line continuation and BOM files remain editable with exact evidence", async (t) => {
	const f = await fixture(t, "\uFEFF" + "😀".repeat(500) + " tail\n");
	let args = { path: "file.txt", limit: 1 };
	for (let count = 0; count < 10; count += 1) {
		const result = await f.workspace.readFileDetailed(args, { maxOutputBytes: 512 });
		f.ledger.recordRead(args.path, result);
		if (result.readInfo.reachedEndOfFile) break;
		args = { path: "file.txt", offset: result.readInfo.nextOffset, ...(result.readInfo.nextColumn ? { column: result.readInfo.nextColumn } : {}), limit: 1 };
	}
	assert.equal(JSON.parse(f.ledger.snapshot()).files[0].completeRead, true);
	await f.execute("edit_file", { path: "file.txt", old_text: " tail", new_text: " end" });
	assert.match(await readFile(join(f.root, "file.txt"), "utf8"), / end\n$/);
});

test("eviction and command invalidation require fresh evidence", async (t) => {
	const f = await fixture(t);
	const ledger = createEvidenceLedger(f.workspace, { maxEvidenceChars: 2 });
	ledger.recordRead("file.txt", await f.workspace.readFileDetailed({ path: "file.txt" }));
	await assert.rejects(ledger.beforeMutation("edit_file", { path: "file.txt", old_text: "first", new_text: "x" }), { code: "READ_REQUIRED" });
	await f.execute("read_file", { path: "file.txt" });
	f.ledger.invalidate();
	await assert.rejects(f.execute("edit_file", { path: "file.txt", old_text: "first", new_text: "x" }), { code: "READ_REQUIRED" });
});

test("large command output preserves failure, exit code and tail under model output limits", () => {
	const output = "Exit code: 7\n" + "x".repeat(12000) + "\nactual failure at end";
	const envelope = toolEnvelope("run_terminal", {}, output, undefined, { maxChars: 2000 });
	assert.equal(envelope.metadata.status, "error");
	assert.equal(envelope.metadata.exitCode, "7");
	assert.equal(envelope.metadata.outputTruncated, true);
	assert.match(envelope.content, /actual failure at end/);
	assert.ok(envelope.content.length < 2400);
});

test("Plan rejects guarded mutation before dispatch and new files can be created in Build", async (t) => {
	const f = await fixture(t);
	assert.throws(() => f.execute("write_file", { path: "new.txt", content: "x" }, "plan"), /unavailable in Plan/);
	await f.execute("write_file", { path: "new.txt", content: "x" });
	assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "x");
});

test("read envelopes expose total lines and continuation without changing exact content", async (t) => {
	const f = await fixture(t);
	const result = await f.execute("read_file", { path: "file.txt", limit: 1 });
	const envelope = toolEnvelope("read_file", { path: "file.txt" }, result);
	assert.equal(envelope.metadata.status, "incomplete");
	assert.equal(envelope.metadata.read.totalLines, 3);
	assert.equal(envelope.metadata.read.nextOffset, 2);
	assert.equal(result.readContent, "first");
	assert.ok(!envelope.content.includes(result.readState.hash));
	assert.equal(toolEnvelope("run_terminal", {}, "Exit code: 2\nfailure").metadata.status, "error");
	assert.equal(toolEnvelope("run_terminal", {}, "Permission denied by the user.").metadata.changed, false);
	assert.equal(toolEnvelope("write_file", {}, "Error: failed", { message: "failed", mayHaveChanged: true }).metadata.changed, "unknown");
});

test("loop guard blocks repeated failures and duplicate results but permits new evidence", () => {
	const guard = createLoopGuard();
	const id = guard.check("edit_file", { path: "x" });
	guard.record(id, { status: "error" }, "failed");
	guard.record(id, { status: "error" }, "failed");
	assert.throws(() => guard.check("edit_file", { path: "x" }), { code: "REPEATED_FAILURE" });
	const read = guard.check("read_file", { path: "x" });
	guard.record(read, { status: "success" }, "new evidence");
	assert.doesNotThrow(() => guard.check("edit_file", { path: "x" }));
	guard.record(read, { status: "success" }, "new evidence");
	guard.record(read, { status: "success" }, "new evidence");
	assert.throws(() => guard.check("read_file", { path: "x" }), { code: "REPEATED_RESULT" });
});

test("compaction preserves metadata and trailing errors; pruning keeps protocol and recent results", () => {
	assert.equal(serializeForSummary([{ role: "user", content: [null, { type: "text", text: "first" }, { type: "image_url", image_url: { url: "data:image/png;base64,private-data" } }, { type: "text", text: "second" }] }]), "[user] first\n[image attached]\nsecond");
	const content = toolEnvelope("read_file", { path: "x" }, { toolText: "start" + "a".repeat(6000) + "next offset=40", readInfo: { nextOffset: 40, reachedEndOfFile: false } }).content;
	const messages = Array.from({ length: 6 }, (_, index) => ({ role: "tool", tool_call_id: `id-${index}`, content }));
	assert.equal(pruneToolHistory(messages), 2);
	assert.equal(messages[0].tool_call_id, "id-0");
	assert.match(messages[0].content, /Old inspection content omitted/);
	assert.equal(messages[5].content, content);
	assert.match(serializeForSummary([messages[5]]), /next offset=40/);
	assert.match(serializeForSummary([messages[5]]), /"nextOffset":40/);
	const longEdit = serializeForSummary([{ role: "assistant", tool_calls: [{ function: { name: "edit_file", arguments: JSON.stringify({ path: "important.mjs", old_text: "x".repeat(100000), new_text: "y".repeat(100000) }) } }] }]);
	assert.ok(longEdit.length < 2400);
	assert.match(longEdit, /important.mjs/);
	assert.match(longEdit, /Argument content omitted/);
});

test("invalid streamed arguments report a repairable code without executing a tool", async () => {
	const response = new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"{"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
	await assert.rejects(readStreamingResponse(response), { code: "INVALID_TOOL_CALL" });
});

test("Chat Completions supports a per-call response limit", async (t) => {
	const requests = [];
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		requests.push(JSON.parse(text));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	const client = createOpenAiClient({ endpoint: `http://127.0.0.1:${server.address().port}`, model: "test", tools: workspaceTools });
	await client.complete([{ role: "user", content: "task" }], { withTools: true, maxTokens: 1024 });
	await client.complete([{ role: "user", content: "summary" }]);
	assert.equal(requests[0].max_tokens, 1024);
	assert.equal(requests[1].max_tokens, undefined);
});
