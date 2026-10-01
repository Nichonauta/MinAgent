import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceAccess } from "../src/workspace.mjs";
import { searchWorkspace } from "../src/search.mjs";
import { investigateAndInitialize } from "../src/init-project.mjs";

async function workspace(t, files) {
	const root = await mkdtemp(join(tmpdir(), "minagent-search-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, name)), { recursive: true });
		await writeFile(join(root, name), content);
	}
	return createWorkspaceAccess(root, "test");
}

test("literal name/content search distinguishes results and returns Unicode locations", async (t) => {
	const w = await workspace(t, { "hello.txt": "😀 hello hello\r\nHELLO", "deep/example.mjs": "const hello = 1;", "other.txt": "nothing" });
	const result = await w.searchFiles({ query: "hello" });
	assert.equal(result.searchInfo.status, "complete");
	assert.equal(result.searchInfo.results.length, 4);
	assert.ok(result.searchInfo.results.some((hit) => hit.type === "filename" && hit.path === "hello.txt"));
	assert.ok(result.searchInfo.results.some((hit) => hit.line === 1 && hit.column === 3 && hit.path === "hello.txt"));
	assert.equal(result.searchInfo.results.filter((hit) => hit.path === "hello.txt" && hit.type === "content").length, 2);
	const sensitive = await w.searchFiles({ query: "hello", mode: "content", case_sensitive: true, path: "deep" });
	assert.deepEqual(sensitive.searchInfo.results.map((hit) => hit.path), ["deep/example.mjs"]);
	assert.equal((await w.searchFiles({ query: "HELLO", mode: "filename", case_sensitive: true })).searchInfo.results.length, 0);
});

test("regex punctuation is searched literally and absent matches are complete", async (t) => {
	const w = await workspace(t, { "a.[x].txt": "look for a.[x] and a.*[x], not ax" });
	assert.equal((await w.searchFiles({ query: "a.[x]" })).searchInfo.results.length, 2);
	assert.equal((await w.searchFiles({ query: "a.*[x]" })).searchInfo.results.length, 1);
	const result = await w.searchFiles({ query: "absent" });
	assert.equal(result.searchInfo.status, "complete");
	assert.equal(result.searchInfo.returnedResults, 0);
});

test("exclusions, binary and invalid UTF-8 files are reported without being searched", async (t) => {
	const w = await workspace(t, { "node_modules/needle.txt": "needle", ".git/needle.txt": "needle", "valid.txt": "needle", "binary.bin": Buffer.from([0, 1, 2]), "invalid.txt": Buffer.from([255, 254]) });
	const result = await w.searchFiles({ query: "needle", mode: "content" });
	assert.deepEqual(result.searchInfo.results.map((hit) => hit.path), ["valid.txt"]);
	assert.equal(result.searchInfo.stats.excludedDirectories, 2);
	assert.equal(result.searchInfo.stats.binaryOrInvalidText, 2);
	await assert.rejects(w.searchFiles({ query: "needle", path: "node_modules" }), /excludes/);
});

test("outside directories and invalid arguments are rejected", async (t) => {
	const w = await workspace(t, {});
	for (const args of [{ query: "" }, { query: "x\ny" }, { query: "x", mode: "regex" }, { query: "x", limit: 501 }, { query: "x", case_sensitive: "yes" }, { query: "x", path: ".." }]) await assert.rejects(w.searchFiles(args));
});

test("result, entry, read, time, and output limits report incomplete searches", async (t) => {
	const w = await workspace(t, { "a.txt": "needle\nneedle\nneedle", "b.txt": "needle" });
	const limited = await w.searchFiles({ query: "needle", mode: "content", limit: 1 });
	assert.deepEqual(limited.searchInfo.reasons, ["result limit"]);
	assert.equal(limited.searchInfo.status, "incomplete");
	for (const [options, reason] of [[{ maxEntries: 1 }, "entry limit"], [{ maxReadBytes: 1 }, "read budget"], [{ timeoutMs: 0 }, "time limit"], [{ maxOutputBytes: 4096 }, "output limit"]]) {
		const result = await searchWorkspace(w, { query: "needle", mode: "content" }, options);
		assert.ok(result.searchInfo.reasons.includes(reason));
	}
});

test("secret values are redacted and long-line snippets center on the match", async (t) => {
	const w = await workspace(t, { "a.txt": 'password="private-value"\n' + "a".repeat(1000) + "needle" + "b".repeat(1000) });
	const secret = await w.searchFiles({ query: "password", mode: "content" });
	assert.doesNotMatch(secret.toolText, /private-value/);
	assert.match(secret.toolText, /REDACTED/);
	const long = await w.searchFiles({ query: "needle", mode: "content" });
	assert.equal(long.searchInfo.results[0].column, 1001);
	assert.ok(long.searchInfo.results[0].snippet.includes("needle"));
	assert.ok(long.searchInfo.results[0].snippet.length <= 402);
});

test("oversized files and truncated listings cannot report exhaustive absence", async (t) => {
	const w = await workspace(t, { "large.txt": "" });
	await truncate(join(w.rootDirectory, "large.txt"), 11 * 1024 * 1024);
	const large = await w.searchFiles({ query: "absent", mode: "content" });
	assert.equal(large.searchInfo.status, "incomplete");
	assert.equal(large.searchInfo.stats.oversizedFiles, 1);
	assert.equal(large.searchInfo.stats.bytesRead, 0);
	const list = w.listDirectory;
	w.listDirectory = async (args) => {
		const result = await list(args);
		result.directoryInfo.truncated = true;
		return result;
	};
	const truncated = await w.searchFiles({ query: "absent", mode: "filename" });
	assert.ok(truncated.searchInfo.reasons.includes("directory listing limit"));
	assert.equal(truncated.searchInfo.status, "incomplete");
});

test("read errors are reported and cancellation preserves partial results", async (t) => {
	const w = await workspace(t, { "a.txt": "needle", "b.txt": "needle" });
	const read = w.readRawFile;
	w.readRawFile = async (path, opts) => { if (path === "b.txt") throw new Error("access denied"); return read(path, opts); };
	const errors = await w.searchFiles({ query: "needle", mode: "content" });
	assert.equal(errors.searchInfo.status, "incomplete");
	assert.equal(errors.searchInfo.stats.errors, 1);
	const controller = new AbortController();
	w.readRawFile = async (path, opts) => { if (path === "b.txt") controller.abort(); return read(path, opts); };
	const result = await w.searchFiles({ query: "needle", mode: "content" }, { signal: controller.signal });
	assert.equal(result.searchInfo.status, "canceled");
	assert.equal(result.searchInfo.results.length, 1);
});

test("search never follows linked entries", async (t) => {
	const w = await workspace(t, { "a.txt": "needle" });
	try { await symlink(join(w.rootDirectory, "a.txt"), join(w.rootDirectory, "link.txt")); }
	catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink permission unavailable"); throw error; }
	const result = await w.searchFiles({ query: "needle", mode: "content" });
	assert.equal(result.searchInfo.results.length, 1);
	assert.equal(result.searchInfo.stats.linkedOrSpecial, 1);
});

test("init can search for sources but search snippets do not satisfy required reads", async (t) => {
	const w = await workspace(t, { "README.md": "facts" });
	let index = 0;
	const responses = [
		{ message: { content: null, tool_calls: [{ id: "search", type: "function", function: { name: "search_files", arguments: '{"query":"facts","mode":"content"}' } }] } },
		{ message: { content: "Ready" } }, { message: { content: "Ready" } },
	];
	await assert.rejects(investigateAndInitialize({ workspace: w, workspaceName: "test", tools: ["list_directory", "read_file", "search_files"].map((name) => ({ function: { name } })), complete: async (_messages, opts) => {
		assert.ok(opts.availableTools.some((tool) => tool.function.name === "search_files"));
		return responses[index++];
	} }), /incomplete/);
	assert.equal(await w.fileState("AGENTS.md"), null);
});
