const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function safeTerminalText(value) {
	return String(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function graphemes(value) {
	return [...graphemeSegmenter.segment(String(value))].map((entry) => entry.segment);
}

function codePointWidth(character) {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined || /\p{Mark}/u.test(character)) return 0;
	if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x11ff)
		|| (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
		|| (codePoint >= 0xac00 && codePoint <= 0xd7af)
		|| (codePoint >= 0xf900 && codePoint <= 0xfaff)
		|| (codePoint >= 0xfe10 && codePoint <= 0xfe6f)
		|| (codePoint >= 0xff00 && codePoint <= 0xff60)
		|| (codePoint >= 0x1f300 && codePoint <= 0x1faff)
		|| (codePoint >= 0x20000 && codePoint <= 0x3fffd)
	) return 2;
	return 1;
}

export function terminalCharacterWidth(cluster) {
	if (/[\uFE0F\u20E3]/u.test(cluster) || /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(cluster)) return 2;
	return [...cluster].reduce((width, character) => width + codePointWidth(character), 0);
}

export function terminalTextWidth(value) {
	return graphemes(value).reduce((width, cluster) => width + terminalCharacterWidth(cluster), 0);
}

export function truncateTerminalText(value, maxWidth) {
	const safe = safeTerminalText(value);
	if (terminalTextWidth(safe) <= maxWidth) return safe;
	if (maxWidth < 1) return "";
	let output = "";
	let width = 0;
	for (const cluster of graphemes(safe)) {
		const nextWidth = terminalCharacterWidth(cluster);
		if (width + nextWidth > maxWidth - 1) break;
		output += cluster;
		width += nextWidth;
	}
	return `${output.trimEnd()}…`;
}

export function wrapTextLine(value, width) {
	let remaining = graphemes(value);
	const lines = [];
	while (terminalTextWidth(remaining.join("")) > width) {
		let usedWidth = 0;
		let cut = 0;
		let lastSpace = -1;
		for (let index = 0; index < remaining.length; index += 1) {
			const characterWidth = terminalCharacterWidth(remaining[index]);
			if (usedWidth + characterWidth > width) break;
			usedWidth += characterWidth;
			cut = index + 1;
			if (/\s/.test(remaining[index])) lastSpace = index;
		}
		const breakAt = lastSpace > 0 ? lastSpace : Math.max(1, cut);
		lines.push(remaining.slice(0, breakAt).join("").trimEnd());
		remaining = remaining.slice(breakAt);
		while (remaining.length && /^\s$/.test(remaining[0])) remaining.shift();
	}
	lines.push(remaining.join(""));
	return lines;
}

export function wrapMessage(text, width) {
	return safeTerminalText(text).split("\n").flatMap((line) => wrapTextLine(line, width));
}

export function terminalRowsForInput(input, promptWidth, columns) {
	let rows = 1;
	let column = promptWidth;
	for (const character of graphemes(input)) {
		if (character === "\n") {
			rows += 1;
			column = 0;
			continue;
		}
		const width = terminalCharacterWidth(character);
		if (column > 0 && column + width > columns) {
			rows += 1;
			column = 0;
		}
		column += width;
	}
	return rows;
}
