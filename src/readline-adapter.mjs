import { terminalRowsForInput } from "./terminal-text.mjs";

export function insertNewline(terminal) {
	if (typeof terminal?.line !== "string") return;
	const cursor = Number.isInteger(terminal.cursor) ? Math.max(0, Math.min(terminal.cursor, terminal.line.length)) : terminal.line.length;
	terminal.line = `${terminal.line.slice(0, cursor)}\n${terminal.line.slice(cursor)}`;
	terminal.cursor = cursor + 1;
	const multilineState = Object.getOwnPropertySymbols(terminal).find((symbol) => symbol.description === "_isMultiline");
	if (multilineState) terminal[multilineState] = true;
	terminal.prompt(true);
}

export function isBulkInputChunk(terminal) {
	if (terminal?.isCompletionEnabled === false) return true;
	const sawKeyPress = Object.getOwnPropertySymbols(terminal ?? {}).find((symbol) => symbol.description === "_sawKeyPress");
	return Boolean(sawKeyPress && terminal[sawKeyPress] === false);
}

export function resetPromptRows(terminal) {
	terminal.prevRows = 0;
	terminal.prompt(true);
}

export function measureSubmittedInputRows(terminal, input, promptWidth, columns) {
	if (typeof terminal?.getCursorPos === "function" && typeof terminal.line === "string") {
		const originalCursor = terminal.cursor;
		try {
			terminal.cursor = terminal.line.length;
			const cursorPosition = terminal.getCursorPos();
			if (Number.isInteger(cursorPosition?.rows)) return cursorPosition.rows + 1;
		} finally {
			terminal.cursor = originalCursor;
		}
	}
	return terminalRowsForInput(input, promptWidth, columns);
}
