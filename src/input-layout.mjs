import { graphemes, terminalCharacterWidth } from "./terminal-text.mjs";

// Rendering and navigation share visual rows and UTF-16 offsets at grapheme boundaries.
export function layoutInput(prompt, line, columns) {
	columns = Math.max(1, columns);
	const plainPrompt = prompt.replace(/[\u0001\u0002]/g, "").replace(/\u001b\[[0-9;]*m/g, "");
	const rows = [""];
	const positions = [];
	let row = 0, column = 0, offset = 0;
	const record = () => {
		if (offset < plainPrompt.length) return;
		positions.push({ offset: offset - plainPrompt.length, row: row + (column === columns ? 1 : 0), column: column === columns ? 0 : column });
	};
	for (const character of graphemes(plainPrompt + line)) {
		const width = terminalCharacterWidth(character);
		if (character !== "\n" && width && column + width > columns) {
			rows.push(""); row += 1; column = 0;
		}
		record();
		if (character === "\n") {
			rows.push(""); row += 1; column = 0;
		} else {
			rows[row] += character;
			column += width;
		}
		offset += character.length;
	}
	record();
	while (rows.length <= positions.at(-1).row) rows.push("");
	return {
		rows, positions, plainPrompt,
		positionAt(cursor) {
			// A cursor left inside a grapheme by readline is drawn at its beginning.
			let position = positions[0];
			for (const candidate of positions) {
				if (candidate.offset > cursor) break;
				position = candidate;
			}
			return position;
		},
	};
}
