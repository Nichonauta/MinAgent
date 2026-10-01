import test from "node:test";
import assert from "node:assert/strict";
import { requestToolPermission } from "../src/tool-permissions.mjs";

test("Ask previews redact secrets and only explicit yes approves", async () => {
	const shown = [], questions = [];
	const options = { mode: "ask", setting: "MCP_MODE", label: "MCP", args: { headers: { Authorization: "Bearer secret-value" }, text: "visible" }, question: "Allow?" };
	for (const answer of ["", "no", "y", " YES "]) {
		const allowed = await requestToolPermission(options, {
			interactiveTerminal: { question: async (question) => { questions.push(question); return answer; } },
			print() {}, uiPrint: (text) => shown.push(text), uiText: (text) => text,
		});
		assert.equal(allowed, ["y", " YES "].includes(answer));
	}
	assert.deepEqual(questions, ["Allow?", "Allow?", "Allow?", "Allow?"]);
	assert.match(shown.join("\n"), /visible|REDACTED/);
	assert.doesNotMatch(shown.join("\n"), /secret-value/);
});

test("Ask refuses unavailable interaction and truncated argument previews before approval", async () => {
	let questions = 0;
	const options = { mode: "ask", setting: "SKILLS_MODE", label: "Skills", args: { name: "demo" }, question: "Allow?" };
	const ui = { print() {}, uiPrint() {}, uiText: (text) => text };
	await assert.rejects(requestToolPermission(options, ui), /outside the interactive terminal/);
	await assert.rejects(requestToolPermission({ ...options, args: { text: "x".repeat(8001) } }, {
		...ui, interactiveTerminal: { question: async () => { questions += 1; return "yes"; } },
	}), /preview limit/);
	assert.equal(questions, 0);
});
