import test from "node:test";
import assert from "node:assert/strict";
import { evaluateModel, evaluationTasks } from "../src/evaluation.mjs";

const calls = (name, args) => ({ message: { content: null, tool_calls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, payload: { usage: { prompt_tokens: 100, completion_tokens: 20 } } });
const answer = (content) => ({ message: { content } });

test("evaluation uses real guarded tools and records recovery from an external edit", async () => {
	let round = 0;
	const replies = [calls("read_file", { path: "value.txt" }), calls("edit_file", { path: "value.txt", old_text: "old", new_text: "new" }), calls("read_file", { path: "value.txt" }), calls("edit_file", { path: "value.txt", old_text: "old", new_text: "new" }), answer("Updated value.txt and preserved external.")];
	const result = await evaluateModel({ tasks: [evaluationTasks.find((task) => task.name === "recover-stale-edit")], complete: async () => replies[round++] });
	assert.equal(result.passed, 1);
	assert.equal(result.results[0].evidenceFailures, 1);
	assert.equal(result.results[0].toolCalls, 4);
	assert.equal(result.results[0].usageAvailable, true);
	assert.equal(result.results[0].promptTokens, 400);
});

test("evaluation reports forbidden Plan attempts while keeping the fixture unchanged", async () => {
	let round = 0;
	const replies = [calls("write_file", { path: "src/greeting.mjs", content: "bad" }), answer("I propose changing the returned string in Build.")];
	const result = await evaluateModel({ tasks: [evaluationTasks.find((task) => task.name === "plan-boundaries")], complete: async () => replies[round++] });
	assert.equal(result.passed, 1);
	assert.equal(result.results[0].modeViolations, 1);
	assert.equal(result.results[0].invalidCalls, 1);
});

test("evaluation rejects fabricated completion that did not produce the required edit", async () => {
	const result = await evaluateModel({ tasks: [evaluationTasks[0]], complete: async () => answer("Done.") });
	assert.equal(result.passed, 0);
	assert.equal(result.results[0].toolCalls, 0);
});

test("evaluation accepts object arguments and checks answers supplied as text parts", async () => {
	const read = calls("read_file", { path: "notes.txt", offset: 351 });
	read.message.tool_calls[0].function.arguments = { path: "notes.txt", offset: 351 };
	const replies = [read, answer([null, { type: "text", text: "FINAL_MARKER" }, { type: "text", text: "violeta-729" }])];
	let round = 0;
	const result = await evaluateModel({ tasks: [evaluationTasks.find((task) => task.name === "read-continuation")], complete: async () => replies[round++] });
	assert.equal(result.passed, 1);
	assert.equal(result.results[0].invalidCalls, 0);
	assert.equal(result.results[0].toolCalls, 1);
});
