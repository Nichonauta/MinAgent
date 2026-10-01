import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration } from "../src/config.mjs";
import { compactionBudget } from "../src/context.mjs";

async function configuration(t) {
	const root = await mkdtemp(join(tmpdir(), "minagent-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return (env = {}) => loadConfiguration({ appDirectory: join(root, "src"), cwd: root, env: { OPENAI_MODEL: "test", ...env } });
}

test("configuration uses the full context window and permission mode defaults", async (t) => {
	const load = await configuration(t);
	const config = await load();
	assert.equal(config.contextWindow, 262144);
	assert.equal(config.terminalMode, "ask");
	assert.equal(config.skillsMode, "off");
	assert.equal(config.mcpMode, "off");
	assert.deepEqual(compactionBudget(config.contextWindow), { reserve: 16384, keepRecent: 20000 });
	assert.deepEqual(compactionBudget(8192), { reserve: 2048, keepRecent: 2048 });
});

test("terminal, skills and MCP accept the same three permission modes", async (t) => {
	const load = await configuration(t);
	for (const mode of ["auto", "ask", "off"]) {
		const config = await load({ TERMINAL_MODE: mode, SKILLS_MODE: mode, MCP_MODE: mode });
		assert.equal(config.terminalMode, mode);
		assert.equal(config.skillsMode, mode);
		assert.equal(config.mcpMode, mode);
	}
});

test("permission settings reject booleans, uppercase names and unsupported modes", async (t) => {
	const load = await configuration(t);
	for (const name of ["TERMINAL_MODE", "SKILLS_MODE", "MCP_MODE"]) {
		for (const value of ["on", "true", "AUTO", "invalid"]) await assert.rejects(load({ [name]: value }), new RegExp(name));
	}
});
