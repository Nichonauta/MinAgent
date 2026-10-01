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

export function truncateStyledTerminalText(value, maxWidth) {
	const parts = String(value).split(/(\u001b\[[0-9;]*m)/g);
	const plain = parts.filter((_, index) => index % 2 === 0).map(safeTerminalText).join("");
	const clipped = truncateTerminalText(plain, maxWidth);
	const truncated = clipped !== plain;
	let remaining = truncated ? Math.max(0, clipped.length - 1) : plain.length;
	let result = "";
	for (let index = 0; index < parts.length; index += 1) {
		if (index % 2) { result += parts[index]; continue; }
		const text = safeTerminalText(parts[index]);
		result += text.slice(0, remaining);
		remaining -= Math.min(remaining, text.length);
		if (remaining === 0) break;
	}
	if (truncated && maxWidth > 0) result += "…";
	return result + (String(value).includes("\u001b[") ? "\u001b[0m" : "");
}

function wrapTextLine(value, width) {
	const clusters = graphemes(value);
	const widths = clusters.map(terminalCharacterWidth);
	let remainingWidth = widths.reduce((sum, size) => sum + size, 0);
	let start = 0;
	const lines = [];
	while (remainingWidth > width) {
		let usedWidth = 0;
		let cut = start;
		let lastSpace = -1;
		for (let index = start; index < clusters.length; index += 1) {
			const characterWidth = widths[index];
			if (usedWidth + characterWidth > width) break;
			usedWidth += characterWidth;
			cut = index + 1;
			if (/\s/.test(clusters[index])) lastSpace = index;
		}
		const breakAt = clusters[cut] && /^\s$/u.test(clusters[cut]) ? cut : lastSpace > start ? lastSpace : Math.max(start + 1, cut);
		lines.push(clusters.slice(start, breakAt).join("").trimEnd());
		let nextStart = breakAt;
		while (nextStart < clusters.length && /^\s$/.test(clusters[nextStart])) nextStart += 1;
		for (let index = start; index < nextStart; index += 1) remainingWidth -= widths[index];
		start = nextStart;
	}
	if (start < clusters.length || lines.length === 0) lines.push(clusters.slice(start).join(""));
	return lines;
}

export function wrapMessage(text, width) {
	return safeTerminalText(text).split("\n").flatMap((line) => wrapTextLine(line, width));
}
