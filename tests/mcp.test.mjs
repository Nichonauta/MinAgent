import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServers, executeMcpTool } from "../src/mcp.mjs";

async function localMcp(t, transport, protocolVersion = "2025-03-26") {
	const root = await mkdtemp(join(tmpdir(), "minagent-mcp-shared-"));
	let connections;
	let server;
	t.after(async () => {
		await connections?.close();
		if (server) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		await rm(root, { recursive: true, force: true });
	});
	// The same server behavior exercises the public connection API through both transports.
	const handle = (call) => {
		if (call.method === "initialize") return { protocolVersion, instructions: "Fixture guidance" };
		if (call.method === "tools/list") {
			if (!call.params.cursor) return { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "second-page" };
			if (call.params.cursor !== "second-page") throw new Error("Wrong pagination cursor");
			return { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
		}
		if (call.method === "tools/call" && call.params.name === "echo") return { content: [{ type: "text", text: call.params.arguments.text }] };
		throw new Error("Unexpected request");
	};
	let settings;
	if (transport === "stdio") {
		const script = join(root, "server.mjs");
		await writeFile(script, `import { createInterface } from "node:readline";
const handle = ${handle.toString()};
const protocolVersion = ${JSON.stringify(protocolVersion)};
const input = createInterface({ input: process.stdin });
for await (const line of input) {
 const call = JSON.parse(line);
 if (call.id === undefined) continue;
 console.log(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: handle(call) }));
}
`);
		const quote = (value) => process.platform === "win32" ? `"${value}"` : value;
		settings = { command: quote(process.execPath), args: [quote(script)] };
	} else {
		server = createServer(async (request, response) => {
			if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
			let body = "";
			for await (const chunk of request) body += chunk;
			const call = JSON.parse(body);
			if (call.id === undefined) {
				assert.equal(call.method, "notifications/initialized");
				assert.equal(request.headers["mcp-protocol-version"], protocolVersion);
				response.writeHead(202); response.end(); return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: handle(call) }));
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		settings = { url: `http://127.0.0.1:${server.address().port}/mcp` };
	}
	const configPath = join(root, "mcp.json");
	await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: settings } }));
	connections = await connectMcpServers({ configPath, defaultCwd: root });
	return connections;
}

for (const transport of ["stdio", "http"]) {
	test(`MCP ${transport} negotiates a supported version, paginates and calls the remote tool`, { timeout: 5000 }, async (t) => {
		const connections = await localMcp(t, transport);
		assert.deepEqual(connections.warnings, []);
		assert.deepEqual(connections.serverGuidance, [{ serverName: "fixture", instructions: "Fixture guidance" }]);
		const names = connections.toolDefinitions.map((tool) => tool.function.name);
		assert.equal(names.length, 2);
		const echo = names.find((name) => name.endsWith("_echo"));
		assert.ok(echo);
		const result = await executeMcpTool(echo, { text: "paginated result" }, connections.toolLookup, false);
		assert.match(result.toolText, /paginated result/);
		assert.equal(result.isError, false);
	});
	test(`MCP ${transport} rejects unsupported protocol versions before tool discovery`, { timeout: 5000 }, async (t) => {
		const connections = await localMcp(t, transport, "unsupported");
		assert.equal(connections.toolDefinitions.length, 0);
		assert.equal(connections.clients.length, 0);
		assert.ok(connections.warnings.some((warning) => /unsupported MCP protocol version/.test(warning)));
	});
}

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
