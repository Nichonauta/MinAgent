import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { createOpenAiClient } from "../src/openai.mjs";
import { modelsEndpoint, normalizeModelCatalog, modelSettings } from "../src/models.mjs";
import { handleModelSelectorKeypress, formatAutocompletePanel } from "../src/editor.mjs";

async function api(t, handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
	return `http://127.0.0.1:${server.address().port}/prefix/v1/chat/completions`;
}

test("catalog URL retains provider prefixes and query parameters", () => {
	assert.equal(modelsEndpoint("https://example.test/provider/v1/chat/completions?tenant=x"), "https://example.test/provider/v1/models?tenant=x");
	assert.throws(() => modelsEndpoint("https://example.test/unrelated"));
});

test("model listing uses existing credentials, validates IDs and keeps metadata", async (t) => {
	const endpoint = await api(t, (request, response) => {
		assert.equal(request.method, "GET");
		assert.equal(request.url, "/prefix/v1/models");
		assert.equal(request.headers.authorization, "Bearer test-key");
		response.end(JSON.stringify({ data: [{ id: "b", context_length: 4096 }, { id: "a" }, { id: "a" }, { id: "" }, { id: "bad\nID" }] }));
	});
	const models = await createOpenAiClient({ endpoint, apiKey: "test-key", model: "a", tools: [] }).listModels();
	assert.deepEqual(models.map((entry) => entry.id), ["a", "b"]);
	assert.equal(models[1].context_length, 4096);
});

test("catalog errors leave a usable client and never follow redirects", async (t) => {
	let code = 401;
	const endpoint = await api(t, (_request, response) => {
		response.writeHead(code, { Location: "/other" });
		response.end("not JSON");
	});
	const client = createOpenAiClient({ endpoint, model: "a", tools: [] });
	await assert.rejects(client.listModels(), /HTTP 401/);
	code = 404;
	await assert.rejects(client.listModels(), /does not expose/);
	code = 200;
	await assert.rejects(client.listModels(), /invalid or oversized/);
	code = 302;
	await assert.rejects(client.listModels());
	assert.throws(() => normalizeModelCatalog({ data: [] }), /no available/);
	assert.throws(() => normalizeModelCatalog({ models: [] }), /data array/);
});

test("catalog requests can be canceled or timed out", async (t) => {
	const endpoint = await api(t, () => {});
	const client = createOpenAiClient({ endpoint, model: "a", tools: [] });
	const controller = new AbortController();
	const request = client.listModels({ signal: controller.signal });
	controller.abort();
	await assert.rejects(request, { name: "AbortError" });
	await assert.rejects(client.listModels({ timeoutMs: 10 }), { name: "TimeoutError" });
});

test("a switched client sends the new model for subsequent completions", async (t) => {
	const sent = [];
	const endpoint = await api(t, async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		sent.push(JSON.parse(body));
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	const messages = [{ role: "user", content: "hello" }];
	await createOpenAiClient({ endpoint, model: "old", tools: [] }).complete(messages);
	await createOpenAiClient({ endpoint, model: "new", tools: [] }).complete(messages, { withTools: true });
	assert.deepEqual(sent.map((body) => body.model), ["old", "new"]);
	assert.deepEqual(sent[1].messages, messages);
});

test("model settings use known metadata, fall back to configuration and protect image history", () => {
	const defaults = { contextWindow: 262144, inputModalities: ["text", "image"] };
	assert.deepEqual(modelSettings({ id: "unknown" }, defaults), { ...defaults, knownContext: false, knownInput: false });
	const settings = modelSettings({ context_length: 8192, architecture: { input_modalities: ["text", "audio"] } }, defaults);
	assert.equal(settings.contextWindow, 8192);
	assert.deepEqual(settings.inputModalities, ["text"]);
	assert.equal(modelSettings({ context_length: -1 }, defaults).contextWindow, 262144);
	assert.throws(() => modelSettings({ input_modalities: ["text"] }, defaults, [{ content: [{ type: "image_url" }] }]), /Use \/new/);
	assert.throws(() => modelSettings({ capabilities: { tools: false } }, defaults), /does not support tools/);
});

test("selector consumes arrows and Enter without submitting the draft to readline", async () => {
	const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
	const output = new PassThrough(); output.isTTY = true; output.columns = 80;
	const terminal = createInterface({ input, output, terminal: true });
	const answer = terminal.question("You › "); answer.catch(() => {});
	let state = { kind: "model", candidates: [{ value: "a", label: "a (current)" }, { value: "b", label: "b" }], selectedIndex: 0, totalMatches: 2 };
	let selected;
	input.prependListener("keypress", (_character, key) => {
		const action = handleModelSelectorKeypress(state, key);
		if (action?.kind === "select") { selected = action.model; state = null; }
	});
	try {
		assert.match(formatAutocompletePanel(state).join("\n"), /MODELS/);
		input.write("\u001b[B"); input.write("\r");
		assert.equal(selected, "b");
		assert.equal(terminal.line, "");
		input.write("hello\r");
		assert.equal(await answer, "hello");
	} finally { terminal.close(); }
	assert.equal(handleModelSelectorKeypress({ candidates: [{ value: "a" }], selectedIndex: 0 }, { name: "escape" }).kind, "cancel");
	assert.equal(handleModelSelectorKeypress({ candidates: [{ value: "a" }], selectedIndex: 0 }, { name: "escape", sequence: "\u001b", meta: true }).kind, "cancel");
});
