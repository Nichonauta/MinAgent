import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalRendering } from "../src/markdown-terminal.mjs";
import { wrapMessage, terminalTextWidth } from "../src/terminal-text.mjs";
import { slashCommands } from "../src/commands.mjs";
import { buildAutocompleteState } from "../src/editor.mjs";
import { PLAN_PROMPT } from "../src/prompts.mjs";

function chat(width = 12, colored = false) {
	let output = "";
	const stdout = { columns: width + 4, write: (value) => { output += value; } };
	const rendering = createTerminalRendering({
		stdout, getUseColor: () => colored,
		UI_COLORS: { assistantBackground: [20, 20, 20], cyan: [0, 200, 200], muted: [100, 100, 100], pale: [220, 220, 220] },
		uiText: (value) => value, uiPrint: (value) => { output += `${value}\n`; }, print: () => {},
	});
	return {
		bubble: rendering.createStreamingOutput("Model"),
		rows: () => output.replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((line) => line.startsWith("│ ")).map((line) => line.slice(2, -2)),
	};
}

test("assistant wraps complete words even when delivered across many chunks", () => {
	const c = chat(12);
	for (const chunk of ["Hola ", "her", "mo", "so ", "mun", "do"]) c.bubble.write(chunk);
	c.bubble.close();
	assert.deepEqual(c.rows().map((row) => row.trimEnd()), ["Hola hermoso", "mundo"]);
});

test("word that does not fit is moved intact with styles inside it", () => {
	const c = chat(12, true);
	for (const chunk of ["Hola ", "her**", "mos", "o**! ", "fin"]) c.bubble.write(chunk);
	c.bubble.close();
	assert.deepEqual(c.rows().map((row) => row.trimEnd()), ["Hola", "hermoso! fin"]);
	assert.ok(c.rows().every((row) => terminalTextWidth(row) === 12));
});

test("interruption flushes the pending word and keeps explicit blank lines", () => {
	const c = chat(12);
	c.bubble.write("Hola\n\npendiente");
	c.bubble.close("interrupted");
	assert.deepEqual(c.rows().map((row) => row.trimEnd()), ["Hola", "", "pendiente"]);
});

test("combining characters and emoji remain together across stream chunks", () => {
	const c = chat(8);
	for (const chunk of ["12345 ", "ca", "fe", "\u0301 ", "👩", "‍", "💻"]) c.bubble.write(chunk);
	c.bubble.close();
	assert.deepEqual(c.rows().map((row) => row.trimEnd()), ["12345", "café 👩‍💻"]);
	assert.ok(c.rows().every((row) => terminalTextWidth(row) === 8));
});

test("only words wider than the whole bubble are split", () => {
	const c = chat(8);
	c.bubble.write("Hi abcdefghijklmnop");
	c.bubble.close();
	assert.deepEqual(c.rows().map((row) => row.trimEnd()), ["Hi", "abcdefgh", "ijklmnop"]);
	assert.deepEqual(wrapMessage("abc def xyz", 7), ["abc def", "xyz"]);
	assert.deepEqual(wrapMessage("Hola hermoso mundo", 12), ["Hola hermoso", "mundo"]);
});

test("a final wide grapheme does not add a blank row; explicit blank lines remain", () => {
	assert.deepEqual(wrapMessage("😀", 1), ["😀"]);
	assert.deepEqual(wrapMessage("a 界", 1), ["a", "界"]);
	assert.deepEqual(wrapMessage("👩‍💻", 1), ["👩‍💻"]);
	assert.deepEqual(wrapMessage("😀\n\n", 1), ["😀", "", ""]);
	assert.deepEqual(wrapMessage("", 1), [""]);
});

test("slash menu puts new first and init second while retaining prefix filtering", () => {
	const expected = ["/new", "/init", "/model", "/compact", "/exit"];
	const state = buildAutocompleteState("/", 1, [], slashCommands);
	assert.deepEqual(state.candidates.map((candidate) => candidate.value), expected);
	assert.equal(state.selectedIndex, 0);
	assert.deepEqual(buildAutocompleteState("/i", 2, [], slashCommands).candidates.map((candidate) => candidate.value), ["/init"]);
});

test("Plan explicitly forbids full code implementations and allows only explanatory snippets", () => {
	assert.match(PLAN_PROMPT, /Do not provide complete implementations, replacement files, or full patches/);
	assert.match(PLAN_PROMPT, /brief pseudocode or minimal snippets only when needed to explain a decision/);
});
