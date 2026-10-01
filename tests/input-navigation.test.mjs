import test from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { layoutInput } from "../src/input-layout.mjs";
import { handleVerticalInput, handleAutocompleteKeypress, buildAutocompleteState } from "../src/editor.mjs";
import { insertNewline } from "../src/readline-adapter.mjs";

function editor(line, cursor = line.length, options = { prompt: "", columns: 80 }) {
	const terminal = { line, cursor, prompt() {} };
	const state = {};
	return { terminal, state, options, move(name) { return handleVerticalInput({ name }, terminal, state, options); } };
}

test("vertical navigation retains the desired column across short and empty lines", () => {
	const e = editor("abcdef\nx\n\nabcdef", 5);
	e.move("down"); assert.equal(e.terminal.cursor, 8);
	e.move("down"); assert.equal(e.terminal.cursor, 9);
	e.move("down"); assert.equal(e.terminal.cursor, 15);
	e.move("down"); assert.equal(e.terminal.cursor, 15);
	e.move("up"); e.move("up"); e.move("up");
	assert.equal(e.terminal.cursor, 5);
	assert.equal(e.terminal.line, "abcdef\nx\n\nabcdef");
});

test("wrapped rows account for the prompt and exact-width insertion row", () => {
	const e = editor("abcdefghij", 2, { prompt: "You › ", columns: 10 });
	e.move("down"); assert.equal(e.terminal.cursor, 10);
	e.move("up"); assert.equal(e.terminal.cursor, 2);
	const full = editor("1234567890", 10, { prompt: "", columns: 10 });
	full.move("up"); assert.equal(full.terminal.cursor, 0);
	full.move("down"); assert.equal(full.terminal.cursor, 10);
});

test("movement never lands inside emoji or combining sequences", () => {
	const line = "abc\n👨‍👩‍👧‍👦é界z\nabcdef";
	const e = editor(line, 3);
	e.move("down");
	assert.equal(e.terminal.cursor, "abc\n👨‍👩‍👧‍👦é".length);
	e.move("down");
	assert.equal(e.terminal.cursor, line.lastIndexOf("abcdef") + 3);
	const layout = layoutInput("", "123456789界", 10);
	assert.deepEqual(layout.positionAt(9), { offset: 9, row: 1, column: 0 });
});

test("editing, horizontal movement and resize reset the desired column", () => {
	for (const change of ["left", "edit", "resize"]) {
		const e = editor("abcdef\nx\nabcdef", 5);
		e.move("down");
		if (change === "left") { e.move("left"); e.terminal.cursor -= 1; }
		if (change === "edit") e.terminal.line = "abcdef\nx\nabcde!";
		if (change === "resize") e.options.columns = 40;
		e.move("down");
		assert.equal(e.terminal.cursor, change === "left" ? 9 : 10);
	}
});

test("single-row input retains history navigation and multiline boundaries consume arrows", () => {
	assert.equal(editor("hello").move("up"), false);
	const e = editor("a\nb", 0);
	assert.equal(e.move("up"), true);
	assert.equal(e.terminal.cursor, 0);
	e.terminal.cursor = 3;
	assert.equal(e.move("down"), true);
	assert.equal(e.terminal.cursor, 3);
});

test("real readline arrows edit a multiline draft without replacing it with history", async () => {
	const input = new PassThrough();
	input.isTTY = true;
	input.setRawMode = () => {};
	const output = new PassThrough();
	output.isTTY = true;
	output.columns = 80;
	const terminal = createInterface({ input, output, terminal: true });
	const answer = terminal.question("You › ");
	answer.catch(() => {});
	try {
		terminal.history.push("old message");
		for (const word of ["first", "second", "third"]) {
			if (terminal.line) insertNewline(terminal);
			terminal.line += word;
			terminal.cursor = terminal.line.length;
		}
		const state = {};
		input.prependListener("keypress", (_character, key) => handleVerticalInput(key, terminal, state));
		input.write("\u001b[A");
		assert.equal(terminal.cursor, 11);
		input.write("!");
		assert.equal(terminal.line, "first\nsecon!d\nthird");
		input.write("\r");
		// Readline may return CR separators on Windows when submitting multiline input.
		assert.equal((await answer).replace(/\r\n?/g, "\n"), "first\nsecon!d\nthird");
	} finally { terminal.close(); }
});

test("autocomplete handles arrows before vertical input", () => {
	const terminal = { line: "/", cursor: 1, prompt() {} };
	const state = buildAutocompleteState("/", 1, [], [{ name: "compact" }, { name: "exit" }]);
	const key = { name: "down" };
	assert.equal(handleAutocompleteKeypress(state, key, terminal).kind, "move");
	assert.equal(state.selectedIndex, 1);
	assert.equal(handleVerticalInput(key, terminal, {}), false);
	assert.equal(terminal.cursor, 1);
});
