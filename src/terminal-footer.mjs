import { graphemes, terminalCharacterWidth, truncateStyledTerminalText } from "./terminal-text.mjs";
import { layoutInput } from "./input-layout.mjs";

const CSI = "\u001b[";

function textPosition(value, columns, start = { row: 0, column: 0 }) {
	let { row, column } = start;
	for (const character of graphemes(value.replace(/\u001b\[[0-9;]*m/g, ""))) {
		if (character === "\n") { row += 1; column = 0; continue; }
		if (character === "\r") { column = 0; continue; }
		const width = terminalCharacterWidth(character);
		if (width && column + width > columns) { row += 1; column = 0; }
		column += width;
	}
	return { row, column };
}

// Ask before readline attaches its input handlers, so the reply cannot become a message.
export async function readTerminalCursor(input, output, timeoutMs = 200) {
	const wasRaw = Boolean(input.isRaw);
	const wasPaused = input.isPaused();
	return new Promise((resolve) => {
		let received = "";
		let timer;
		const finish = (position) => {
			clearTimeout(timer);
			input.removeListener("data", onData);
			input.setRawMode?.(wasRaw);
			if (wasPaused) input.pause();
			// Preserve keystrokes that arrived while waiting for the terminal reply.
			const remaining = received.replace(/\u001b\[\d+;\d+R/g, "");
			if (remaining) input.unshift(Buffer.from(remaining));
			resolve(position);
		};
		const onData = (chunk) => {
			received += chunk.toString();
			const match = received.match(/\u001b\[(\d+);(\d+)R/);
			if (match) finish({ row: Number(match[1]), column: Number(match[2]) - 1 });
		};
		input.setRawMode?.(true);
		input.on("data", onData);
		input.resume();
		timer = setTimeout(() => finish(undefined), timeoutMs);
		output.write(`${CSI}6n`);
	});
}

export function createTerminalFooter(output, initialPosition = { row: 1, column: 0 }) {
	let transcript = { ...initialPosition };
	let bottom = 0;
	let previousHeight = output.rows || 24;
	let saved = false;
	const move = (row, column = 0) => `${CSI}${row};${column + 1}H`;
	const restoreTranscript = () => {
		if (saved) output.write("\u001b8");
		else output.write(move(transcript.row, Math.min((output.columns || 80) - 1, transcript.column)));
	};
	return {
		write(value) {
			restoreTranscript();
			if (value.includes(`${CSI}2J${CSI}H`)) transcript = { row: 1, column: 0 };
			// Cursor save/restore can discard the terminal's delayed wrap flag.
			const visible = value.replace(/\u001b\[[0-9;]*m/g, "");
			if (transcript.column >= (output.columns || 80) && visible && !/^[\r\n\u001b]/.test(visible)) {
				output.write("\r\n");
				transcript.row = Math.min(bottom || previousHeight, transcript.row + 1);
				transcript.column = 0;
			}
			output.write(value);
			transcript = textPosition(value.replace(/\u001b\[[0-9;]*[JH]/g, ""), output.columns || 80, transcript);
			transcript.row = Math.min(bottom || previousHeight, transcript.row);
			output.write("\u001b7");
			saved = true;
		},
		render({ status, prompt, line, cursor, suggestions = [], hints = "" }) {
			const height = Math.max(3, output.rows || 24);
			const columns = Math.max(1, output.columns || 80);
			const layout = layoutInput(prompt, line, columns);
			const { plainPrompt, rows: visualRows } = layout;
			const caret = layout.positionAt(cursor);
			const hintRows = hints && height >= 4 ? 1 : 0;
			// Keep the selector visible even when a long draft occupies the input viewport.
			const reservedPanelRows = Math.min(suggestions.length, Math.max(0, height - 3 - hintRows));
			const inputRows = Math.min(height - 2 - hintRows - reservedPanelRows, visualRows.length);
			const panel = suggestions.slice(0, Math.max(0, height - 2 - hintRows - inputRows));
			const nextBottom = height - 1 - hintRows - panel.length - inputRows;
			restoreTranscript();
			if (nextBottom !== bottom || height !== previousHeight) {
				// Clear the old footer before its rows rejoin the history region.
				if (bottom) output.write(`${move(Math.min(height, bottom + 1))}${CSI}J`);
				const overflow = Math.max(0, transcript.row - nextBottom);
				if (overflow) {
					output.write(`${CSI}1;${Math.min(height, Math.max(nextBottom, transcript.row))}r${CSI}${overflow}S`);
					transcript.row -= overflow;
				}
				bottom = nextBottom;
				previousHeight = height;
				output.write(`${CSI}1;${bottom}r${move(transcript.row, Math.min(columns - 1, transcript.column))}`);
			}
			output.write("\u001b7");
			saved = true;
			output.write(`${move(bottom + 1)}${CSI}J${status}`);
			if (hintRows) output.write(`${move(bottom + 2)}${CSI}0m${truncateStyledTerminalText(hints, columns)}`);
			for (let index = 0; index < panel.length; index += 1) output.write(`${move(bottom + 2 + hintRows + index)}${panel[index]}`);
			const inputStart = bottom + 2 + hintRows + panel.length;
			const firstRow = Math.max(0, caret.row - inputRows + 1);
			// Draw individual visual rows, keeping oversized pasted input inside the footer.
			for (let index = 0; index < inputRows; index += 1) {
				let text = visualRows[firstRow + index] || "";
				if (firstRow + index === 0 && text.startsWith(plainPrompt)) {
					text = prompt.replace(/[\u0001\u0002]/g, "") + text.slice(plainPrompt.length);
				}
				output.write(`${move(inputStart + index)}${CSI}0m${text}`);
			}
			output.write(`${move(inputStart + caret.row - firstRow, Math.min(columns - 1, caret.column))}${CSI}?25h`);
		},
	};
}
