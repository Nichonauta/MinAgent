import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServers, executeMcpTool } from "../src/mcp.mjs";

test("MCP HTTP accepts a response event while the SSE connection remains open", { timeout: 5000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "minagent-mcp-test-"));
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const call = JSON.parse(body);
		if (call.id === undefined) {
			response.writeHead(202);
			response.end();
			return;
		}
		const result = call.method === "initialize"
			? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" } }
			: call.method === "tools/list"
				? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] }
				: { content: [{ type: "text", text: "ok" }] };
		response.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "test-session" });
		response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: call.id, result })}\n\n`);
		// Keep the response open. The client must stop reading after the matching ID.
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	});
	const configPath = join(root, "mcp.json");
	await writeFile(configPath, JSON.stringify({ mcpServers: { local: { url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
	const connections = await connectMcpServers({ configPath, defaultCwd: root });
	t.after(() => connections.close());
	assert.deepEqual(connections.warnings, []);
	assert.equal(connections.toolDefinitions.length, 1);
	const result = await executeMcpTool(connections.toolDefinitions[0].function.name, {}, connections.toolLookup, false);
	assert.match(result.toolText, /ok/);
});

test("MCP tool discovery keeps the first 32 tools from an oversized list", { timeout: 5000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "minagent-mcp-test-"));
	const server = createServer(async (request, response) => {
		if (request.method === "DELETE") {
			response.writeHead(204);
			response.end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const call = JSON.parse(body);
		if (call.id === undefined) {
			response.writeHead(202);
			response.end();
			return;
		}
		const result = call.method === "initialize"
			? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "test", version: "1" } }
			: { tools: Array.from({ length: 33 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: "object", properties: {} } })) };
		response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "limit-test" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	});
	const configPath = join(root, "mcp.json");
	await writeFile(configPath, JSON.stringify({ mcpServers: { local: { url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
	const connections = await connectMcpServers({ configPath, defaultCwd: root });
	t.after(() => connections.close());
	assert.equal(connections.toolDefinitions.length, 32);
	assert.ok(connections.warnings.some((warning) => /first 32/.test(warning)));
});
