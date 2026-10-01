import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTerminalFooter, readTerminalCursor } from "../src/terminal-footer.mjs";
import { truncateStyledTerminalText } from "../src/terminal-text.mjs";

test("colored footer text truncates by visible width and resets styles", () => {
	const styled = "\u001b[35mModel\u001b[0m · \u001b[32mReady\u001b[0m";
	const clipped = truncateStyledTerminalText(styled, 10);
	assert.equal(clipped.replace(/\u001b\[[0-9;]*m/g, ""), "Model · R…");
	assert.ok(clipped.includes("\u001b[32m"));
	assert.ok(clipped.endsWith("\u001b[0m"));
	assert.equal(truncateStyledTerminalText("Ready", 80), "Ready");
});

// Minimal screen model checks visible content as well as cursor positions.
function screen(rows = 24, columns = 40) {
	let row = 1, column = 0, bottom = rows, saved;
	const cells = Array.from({ length: rows }, () => "");
	const scroll = (count) => {
		for (let index = 0; index < count; index += 1) {
			cells.splice(0, 1);
			cells.splice(bottom - 1, 0, "");
		}
	};
	const output = {
		rows, columns,
		write(value) {
			for (const token of value.match(/\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]|[\s\S]/gu) || []) {
				const match = token.match(/^\u001b\[([0-9;?]*)([A-Za-z])$/);
				if (token === "\u001b7") { saved = { row, column }; continue; }
				if (token === "\u001b8") { ({ row, column } = saved); continue; }
				if (match) {
					const args = match[1].split(";").map(Number);
					if (match[2] === "H") { row = args[0] || 1; column = (args[1] || 1) - 1; }
					if (match[2] === "r") { bottom = args[1] || rows; row = 1; column = 0; }
					if (match[2] === "S") scroll(args[0] || 1);
					if (match[2] === "J") {
						for (let index = match[1] === "2" ? 0 : row - 1; index < cells.length; index += 1) cells[index] = "";
					}
					continue;
				}
				if (token === "\r") { column = 0; continue; }
				if (token === "\n" || column >= columns) {
					if (row === bottom) scroll(1); else row += 1;
					column = 0;
					if (token === "\n") continue;
				}
				cells[row - 1] = (cells[row - 1] || "").padEnd(column, " ").slice(0, column) + token;
				column += 1;
			}
		},
		get cursor() { return { row, column }; },
		get cells() { return cells; },
	};
	return output;
}

const idle = { status: "Ready", prompt: "You › ", line: "", cursor: 0 };

test("shortcut hints remain in the footer while streaming and opening suggestions", () => {
	const output = screen(24, 80);
	const footer = createTerminalFooter(output);
	const state = { ...idle, hints: "/ commands  @ files  Ctrl+J new line  Esc stop" };
	footer.render(state);
	assert.equal(output.cells[21], "Ready");
	assert.equal(output.cells[22], state.hints);
	assert.equal(output.cells[23], "You › ");
	footer.write("Working\n");
	footer.render({ ...state, suggestions: ["Commands", "compact"], line: "/", cursor: 1 });
	assert.ok(output.cells.includes(state.hints));
	assert.equal(output.cells[0], "Working");
	assert.deepEqual(output.cursor, { row: 24, column: 7 });
	footer.render(state);
	assert.equal(output.cells[22], state.hints);
	assert.ok(!output.cells.includes("Commands"));
});

test("hints truncate on narrow screens and leave room for long drafts", () => {
	const output = screen(6, 10);
	const footer = createTerminalFooter(output);
	const state = { ...idle, hints: "/ commands  @ files", line: "a\nb\nc\nd\ne", cursor: 9 };
	footer.render(state);
	assert.equal(output.cells[2], "/ command…");
	assert.deepEqual(output.cursor, { row: 6, column: 1 });
	output.rows = 3;
	footer.render(state);
	assert.equal(output.cells[1], "Ready");
	assert.equal(output.cells[2], "e");
	assert.deepEqual(output.cursor, { row: 3, column: 1 });
});

test("model selector remains visible with a draft taller than the terminal", () => {
	const output = screen(8, 40);
	const footer = createTerminalFooter(output);
	footer.render({ ...idle, line: "a\nb\nc\nd\ne\nf\ng\nh\ni", cursor: 17, hints: "/ commands", suggestions: ["MODELS", "a (current)", "b", "Enter switch"] });
	assert.ok(output.cells.includes("MODELS"));
	assert.ok(output.cells.includes("Enter switch"));
	assert.equal(output.cells[7], "i");
	assert.deepEqual(output.cursor, { row: 8, column: 1 });
});

test("footer uses two rows and preserves the initial transcript position", () => {
	const output = screen();
	output.cells[0] = "Session";
	const footer = createTerminalFooter(output, { row: 3, column: 0 });
	footer.render(idle);
	assert.equal(output.cells[22], "Ready");
	assert.equal(output.cells[23], "You › ");
	assert.deepEqual(output.cursor, { row: 24, column: 6 });
	footer.write("Hello\n");
	footer.render(idle);
	assert.equal(output.cells[2], "Hello");
	assert.equal(output.cells[0], "Session");
	assert.deepEqual(output.cursor, { row: 24, column: 6 });
});

test("streaming, suggestions and multiline input keep history and draft separate", () => {
	const output = screen();
	const footer = createTerminalFooter(output, { row: 1, column: 0 });
	footer.render(idle);
	footer.write("Partial");
	footer.render({ ...idle, line: "draft\nnext", cursor: 8, suggestions: ["Files", "one", "two"] });
	assert.deepEqual(output.cursor, { row: 24, column: 2 });
	footer.write(" response\n");
	footer.render(idle);
	assert.equal(output.cells[0], "Partial response");
	assert.ok(!output.cells.join("\n").includes("Files"));
	assert.equal(output.cells[23], "You › ");
});

test("expanding the footer scrolls history before overwriting its last rows", () => {
	const output = screen(12);
	const footer = createTerminalFooter(output, { row: 1, column: 0 });
	footer.render(idle);
	for (let index = 0; index < 12; index += 1) footer.write(`message ${index}\n`);
	footer.render({ ...idle, suggestions: ["Files", "one", "two"] });
	assert.ok(output.cells.includes("message 11"));
	assert.equal(output.cells[7], "Ready");
	assert.equal(output.cells[11], "You › ");
	footer.write("continued\n");
	footer.render(idle);
	assert.ok(output.cells.includes("continued"));
	assert.ok(!output.cells.includes("Files"));
});

test("a full-width streamed line continues on the next history row", () => {
	const output = screen(12, 10);
	const footer = createTerminalFooter(output);
	footer.render(idle);
	footer.write("1234567890");
	footer.render(idle);
	footer.write("next\n");
	footer.render(idle);
	assert.equal(output.cells[0], "1234567890");
	assert.equal(output.cells[1], "next");
});

test("oversized drafts and exact-width caret stay inside a small terminal", () => {
	const output = screen(6, 10);
	const footer = createTerminalFooter(output);
	footer.render({ ...idle, line: "1234", cursor: 4 });
	assert.deepEqual(output.cursor, { row: 6, column: 0 });
	footer.render({ ...idle, line: "a\nb\nc\nd\ne\nf\ng", cursor: 13 });
	assert.deepEqual(output.cursor, { row: 6, column: 1 });
	assert.equal(output.cells[5], "g");
	output.rows = 5;
	footer.render(idle);
	assert.deepEqual(output.cursor, { row: 5, column: 6 });
});

test("cursor query accepts a fragmented reply and preserves typed input", async () => {
	const input = new PassThrough();
	input.pause();
	const result = readTerminalCursor(input, { write() {
		input.write("x\u001b[12;");
		input.write("3R");
	} });
	assert.deepEqual(await result, { row: 12, column: 2 });
	assert.equal(input.read().toString(), "x");
});

test("clearing a conversation restarts its transcript above the footer", () => {
	const output = screen();
	const footer = createTerminalFooter(output, { row: 8, column: 0 });
	footer.render(idle);
	footer.write("old conversation\n");
	footer.render(idle);
	footer.write("\u001b[2J\u001b[H");
	footer.write("new session\n");
	footer.render({ ...idle, prompt: "Allow command? ", line: "yes", cursor: 3 });
	assert.equal(output.cells[0], "new session");
	assert.ok(!output.cells.join("\n").includes("old conversation"));
	assert.equal(output.cells[23], "Allow command? yes");
	assert.deepEqual(output.cursor, { row: 24, column: 18 });
});

test("cursor query times out when terminal replies are unsupported", async () => {
	const input = new PassThrough();
	input.pause();
	assert.equal(await readTerminalCursor(input, { write() {} }, 5), undefined);
});
