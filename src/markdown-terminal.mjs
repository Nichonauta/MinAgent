import { graphemes, safeTerminalText, terminalCharacterWidth, terminalTextWidth, truncateTerminalText } from "./terminal-text.mjs";

export function createTerminalRendering({ stdout, getUseColor, UI_COLORS, uiText, uiPrint, print }) {
	class MarkdownTerminalRenderer {
		constructor(write) {
			this.writeDisplay = write;
			this.atLineStart = true;
			this.startProbe = "";
			this.tableLine = null;
			this.pendingTableHeader = null;
			this.tableMode = false;
			this.tableWidths = [];
			this.tableAlignments = [];
			this.inFence = false;
			this.openingFence = false;
			this.closingFence = false;
			this.ignoreLine = false;
			this.fenceInfo = "";
			this.linkBuffer = null;
			this.pendingBang = false;
			this.pendingMarker = "";
			this.bold = false;
			this.italic = false;
			this.italicMarker = "";
			this.inlineCode = false;
			this.heading = false;
			this.quote = false;
			this.linkStyle = false;
			this.lastVisibleChar = "";
		}

		emitText(value) {
			this.writeDisplay(safeTerminalText(value));
		}

		syncStyle() {
			if (!getUseColor()) return;
			const background = UI_COLORS.assistantBackground;
			const codes = [`48;2;${background.join(";")}`];
			if (this.bold || this.heading) codes.push("1");
			if (this.italic) codes.push("3");
			if (this.linkStyle) codes.push("4");
			const color = this.heading || this.inlineCode || this.linkStyle
				? UI_COLORS.cyan
				: this.quote ? UI_COLORS.muted : this.inFence ? UI_COLORS.pale : null;
			if (color) codes.push(`38;2;${color.join(";")}`);
			this.writeDisplay(`\u001b[0m${codes.length ? `\u001b[${codes.join(";")}m` : ""}`);
		}

		write(input) {
			for (const character of String(input)) {
				if (character === "\r") continue;
				if (character === "\n") {
					this.newline();
					continue;
				}
				this.accept(character);
			}
		}

		accept(character) {
			if (this.tableLine !== null) {
				this.tableLine += character;
				return;
			}
			if (this.openingFence) {
				this.fenceInfo += character;
				return;
			}
			if (this.ignoreLine) return;
			if (this.atLineStart) {
				this.acceptLineStart(character);
				return;
			}
			if (this.inFence) {
				this.emitText(character);
				return;
			}
			this.acceptInline(character);
		}

		acceptLineStart(character) {
			if (character !== "|") this.finishTableBeforeText();
			this.startProbe += character;
			const probe = this.startProbe;

			if (this.inFence) {
				if (["`", "``"].includes(probe)) return;
				if (probe === "```") {
					this.inFence = false;
					this.closingFence = true;
					this.startProbe = "";
					this.atLineStart = false;
					this.syncStyle();
					return;
				}
				this.startProbe = "";
				this.atLineStart = false;
				this.emitText(`  ${probe}`);
				return;
			}

			if (probe === "|") {
				this.tableLine = probe;
				this.startProbe = "";
				this.atLineStart = false;
				return;
			}
			if (/^`{1,2}$/.test(probe)) return;
			if (probe === "```") {
				this.inFence = true;
				this.openingFence = true;
				this.fenceInfo = "";
				this.startProbe = "";
				this.atLineStart = false;
				this.syncStyle();
				return;
			}
			if (/^#{1,6}$/.test(probe)) return;
			if (/^#{1,6} $/.test(probe)) {
				this.startProbe = "";
				this.atLineStart = false;
				this.heading = true;
				this.syncStyle();
				return;
			}
			if (/^#{1,6}\s/.test(probe)) {
				this.startProbe = "";
				this.atLineStart = false;
				this.heading = true;
				this.syncStyle();
				this.acceptInline(probe.replace(/^#{1,6}\s/, ""));
				return;
			}
			if (["-", "--", "---"].includes(probe)) return;
			if (/^-{3,} $/.test(probe)) {
				this.startProbe = "";
				this.atLineStart = false;
				this.ignoreLine = true;
				this.emitText("────────────────────────────────────");
				return;
			}
			if (["- ", "+ ", "* "].includes(probe)) {
				this.startProbe = "";
				this.atLineStart = false;
				this.emitText("• ");
				return;
			}
			if (probe === "> ") {
				this.startProbe = "";
				this.atLineStart = false;
				this.quote = true;
				this.syncStyle();
				this.emitText("│ ");
				return;
			}
			if (/^\d{1,5}$/.test(probe) || /^\d{1,5}\.$/.test(probe)) return;
			const numberedList = probe.match(/^(\d{1,5})\. $/);
			if (numberedList) {
				this.startProbe = "";
				this.atLineStart = false;
				this.emitText(`${numberedList[1]}. `);
				return;
			}
			if (/^-{3,}$/.test(probe) || /^[+*-]$/.test(probe)) return;

			this.startProbe = "";
			this.atLineStart = false;
			for (const pending of probe) this.acceptInline(pending);
		}

		acceptInline(character) {
			if (this.pendingBang) {
				this.pendingBang = false;
				if (character === "[") {
					this.linkBuffer = "![";
					return;
				}
				this.emitText("!");
			}
			if (this.linkBuffer !== null) {
				this.linkBuffer += character;
				if (this.linkBuffer.length > 4096) {
					this.emitText(this.linkBuffer);
					this.linkBuffer = null;
					return;
				}
				const targetStart = this.linkBuffer.startsWith("![") ? 2 : 1;
				const linkStart = this.linkBuffer.indexOf("](", targetStart);
				if (linkStart < 0) {
					const lastClose = this.linkBuffer.lastIndexOf("]");
					if (lastClose >= 0 && lastClose < this.linkBuffer.length - 1) {
						this.emitText(this.linkBuffer);
						this.linkBuffer = null;
					}
					return;
				}
				if (!this.linkBuffer.endsWith(")")) return;
				const image = this.linkBuffer.startsWith("![");
				const label = this.linkBuffer.slice(targetStart, linkStart);
				const url = this.linkBuffer.slice(linkStart + 2, -1);
				this.linkBuffer = null;
				if (image) this.emitText("🖼 ");
				this.linkStyle = true;
				this.syncStyle();
				this.emitText(label || url);
				this.linkStyle = false;
				this.syncStyle();
				if (label && url) this.emitText(` (${url})`);
				return;
			}
			if (character === "!") {
				this.pendingBang = true;
				return;
			}
			if (character === "[") {
				this.linkBuffer = "[";
				return;
			}
			if (this.inlineCode) {
				if (character === "`") {
					this.inlineCode = false;
					this.syncStyle();
				} else {
					this.emitText(character);
				}
				return;
			}
			if (this.pendingMarker) {
				const marker = this.pendingMarker;
				if (character === marker[0] && marker.length === 1) {
					this.pendingMarker += character;
					return;
				}
				this.pendingMarker = "";
				if (marker.length === 2) {
					this.bold = !this.bold;
					this.syncStyle();
					this.acceptInline(character);
					return;
				}
				if (this.italic && this.italicMarker === marker) {
					this.italic = false;
					this.italicMarker = "";
					this.syncStyle();
				} else if (!/\s/.test(character) && (marker === "*" || !/[\w]/.test(this.lastVisibleChar))) {
					this.italic = true;
					this.italicMarker = marker;
					this.syncStyle();
				} else {
					this.emitText(marker);
				}
				this.acceptInline(character);
				return;
			}
			if (character === "`") {
				this.inlineCode = true;
				this.syncStyle();
				return;
			}
			if (character === "*" || character === "_") {
				this.pendingMarker = character;
				return;
			}
			this.emitText(character);
			if (!/\s/.test(character)) this.lastVisibleChar = character;
		}

		flushInlinePending() {
			if (this.pendingBang) {
				this.emitText("!");
				this.pendingBang = false;
			}
			if (this.linkBuffer !== null) {
				this.emitText(this.linkBuffer);
				this.linkBuffer = null;
			}
			if (this.pendingMarker) {
				if (this.pendingMarker.length === 1 && this.italic && this.italicMarker === this.pendingMarker) {
					this.italic = false;
					this.italicMarker = "";
					this.syncStyle();
				} else if (this.pendingMarker.length === 2) {
					this.bold = !this.bold;
					this.syncStyle();
				} else {
					this.emitText(this.pendingMarker);
				}
				this.pendingMarker = "";
			}
		}

		flushStartProbe() {
			if (!this.startProbe) return;
			if (/^-{3,}$/.test(this.startProbe)) {
				this.emitText("────────────────────────────────────");
				this.startProbe = "";
				this.atLineStart = false;
				return;
			}
			const pending = this.startProbe;
			this.startProbe = "";
			this.atLineStart = false;
			for (const character of pending) this.acceptInline(character);
		}

		parseTableCells(line) {
			const source = line.trim().replace(/^\|/, "");
			const cells = [];
			let cell = "";
			let codeTicks = 0;
			for (let index = 0; index < source.length; index += 1) {
				const character = source[index];
				if (character === "\\" && source[index + 1] === "|") {
					cell += "|";
					index += 1;
					continue;
				}
				if (character === "`") {
					let run = 1;
					while (source[index + run] === "`") run += 1;
					if (codeTicks === 0) codeTicks = run;
					else if (codeTicks === run) codeTicks = 0;
					cell += "`".repeat(run);
					index += run - 1;
					continue;
				}
				if (character === "|" && codeTicks === 0) {
					cells.push(cell.trim());
					cell = "";
					continue;
				}
				cell += character;
			}
			cells.push(cell.trim());
			if (source.endsWith("|") && cells.at(-1) === "") cells.pop();
			return cells;
		}

		isTableSeparator(cells) {
			return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
		}

		formatTableCell(value) {
			return safeTerminalText(value)
				.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/(`+)(.*?)\1/g, "$2")
				.replace(/(\*\*|__)(.*?)\1/g, "$2")
				.replace(/(?<!\w)([*_])([^*_]+)\1(?!\w)/g, "$2")
				.replace(/\s+/g, " ")
				.trim();
		}

		wrapTableCell(value, width) {
			const text = this.formatTableCell(value);
			if (!text) return [""];
			const lines = [];
			let line = "";
			let lineWidth = 0;
			for (const word of text.split(/\s+/)) {
				const wordWidth = terminalTextWidth(word);
				if (line && lineWidth + 1 + wordWidth <= width) {
					line += ` ${word}`;
					lineWidth += 1 + wordWidth;
					continue;
				}
				if (line) {
					lines.push(line);
					line = "";
					lineWidth = 0;
				}
				for (const character of graphemes(word)) {
					const characterWidth = terminalCharacterWidth(character);
					if (line && lineWidth + characterWidth > width) {
						lines.push(line);
						line = "";
						lineWidth = 0;
					}
					line += character;
					lineWidth += characterWidth;
				}
			}
			if (line) lines.push(line);
			return lines.length ? lines : [""];
		}

		initializeTableColumns(header, separator) {
			const columnCount = Math.max(header.length, separator.length);
			const contentWidth = Math.max(8, Math.min(96, (stdout.columns || 80) - 4));
			const availableWidth = Math.max(columnCount, contentWidth - 3 * (columnCount - 1));
			const minimumWidth = Math.max(1, Math.min(4, Math.floor(availableWidth / columnCount)));
			this.tableWidths = Array.from({ length: columnCount }, (_, index) =>
				Math.max(minimumWidth, terminalTextWidth(this.formatTableCell(header[index] ?? ""))));
			let totalWidth = this.tableWidths.reduce((sum, width) => sum + width, 0);
			while (totalWidth > availableWidth) {
				let widestIndex = -1;
				for (let index = 0; index < this.tableWidths.length; index += 1) {
					if (this.tableWidths[index] <= minimumWidth) continue;
					if (widestIndex < 0 || this.tableWidths[index] > this.tableWidths[widestIndex]) widestIndex = index;
				}
				if (widestIndex < 0) break;
				this.tableWidths[widestIndex] -= 1;
				totalWidth -= 1;
			}
			if (totalWidth < availableWidth) this.tableWidths[this.tableWidths.length - 1] += availableWidth - totalWidth;
			this.tableAlignments = Array.from({ length: columnCount }, (_, index) => {
				const cell = separator[index] ?? "";
				return cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left";
			});
		}

		renderTableRow(cells, header = false) {
			const wrappedCells = this.tableWidths.map((width, index) => this.wrapTableCell(cells[index] ?? "", width));
			const lineCount = Math.max(1, ...wrappedCells.map((lines) => lines.length));
			for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
				if (lineIndex > 0) this.emitText("\n");
				if (header) {
					this.bold = true;
					this.heading = true;
					this.syncStyle();
				}
				const rendered = this.tableWidths.map((width, columnIndex) => {
					const cell = wrappedCells[columnIndex][lineIndex] ?? "";
					const padding = Math.max(0, width - terminalTextWidth(cell));
					const alignment = this.tableAlignments[columnIndex];
					const leftPadding = alignment === "right" ? padding : alignment === "center" ? Math.floor(padding / 2) : 0;
					return `${" ".repeat(leftPadding)}${cell}${" ".repeat(padding - leftPadding)}`;
				}).join(" │ ");
				this.emitText(rendered);
				if (header) {
					this.bold = false;
					this.heading = false;
					this.syncStyle();
				}
			}
		}

		renderTableSeparator() {
			this.emitText(this.tableWidths.map((width) => "─".repeat(width)).join("─┼─"));
		}

		flushPendingTableHeader(includeNewline = true) {
			if (!this.pendingTableHeader) return;
			this.emitText(this.pendingTableHeader.raw);
			if (includeNewline) this.emitText("\n");
			this.pendingTableHeader = null;
		}

		finishTableBeforeText() {
			this.tableMode = false;
			this.tableWidths = [];
			this.tableAlignments = [];
			this.flushPendingTableHeader(true);
		}

		consumeTableLine(line, includeNewline) {
			const cells = this.parseTableCells(line);
			if (this.tableMode) {
				if (!this.isTableSeparator(cells)) {
					this.renderTableRow(cells);
					if (includeNewline) this.emitText("\n");
				}
				return;
			}
			if (this.pendingTableHeader && this.isTableSeparator(cells)) {
				const header = this.pendingTableHeader.cells;
				this.pendingTableHeader = null;
				this.initializeTableColumns(header, cells);
				this.renderTableRow(header, true);
				if (includeNewline) this.emitText("\n");
				this.renderTableSeparator();
				if (includeNewline) this.emitText("\n");
				this.tableMode = true;
				return;
			}
			if (this.pendingTableHeader) this.flushPendingTableHeader(true);
			if (this.isTableSeparator(cells)) {
				this.emitText(line);
				if (includeNewline) this.emitText("\n");
				return;
			}
			this.pendingTableHeader = { raw: line, cells };
		}

		newline() {
			if (this.tableLine !== null) {
				this.consumeTableLine(this.tableLine, true);
				this.tableLine = null;
				this.atLineStart = true;
				return;
			}
			this.tableMode = false;
			this.tableWidths = [];
			this.tableAlignments = [];
			this.flushPendingTableHeader(true);
			if (this.openingFence) {
				this.emitText(`  Code${this.fenceInfo.trim() ? ` ${this.fenceInfo.trim()}` : ""}\n`);
				this.openingFence = false;
				this.fenceInfo = "";
				this.atLineStart = true;
				return;
			}
			if (this.closingFence) {
				this.closingFence = false;
				this.emitText("\n");
				this.atLineStart = true;
				return;
			}
			if (this.ignoreLine) {
				this.ignoreLine = false;
				this.emitText("\n");
				this.atLineStart = true;
				return;
			}
			this.flushStartProbe();
			this.flushInlinePending();
			this.heading = false;
			this.quote = false;
			this.syncStyle();
			this.emitText("\n");
			this.atLineStart = true;
		}

		end() {
			if (this.tableLine !== null) {
				this.consumeTableLine(this.tableLine, false);
				this.tableLine = null;
			}
			this.tableMode = false;
			this.flushPendingTableHeader(false);
			if (this.openingFence) {
				this.emitText(`  Code${this.fenceInfo.trim() ? ` ${this.fenceInfo.trim()}` : ""}`);
				this.openingFence = false;
			}
			this.flushStartProbe();
			this.flushInlinePending();
			this.bold = false;
			this.italic = false;
			this.inlineCode = false;
			this.heading = false;
			this.quote = false;
			this.linkStyle = false;
			this.syncStyle();
		}
	}

	function createAssistantBubbleWriter(label) {
		const columns = stdout.columns || 80;
		const contentWidth = Math.max(8, Math.min(96, columns - 4));
		const background = UI_COLORS.assistantBackground;
		const backgroundStyle = getUseColor() ? `\u001b[48;2;${background.join(";")}m` : "";
		let lineWidth = 0;
		let lineStarted = false;
		let activeStyle = "";
		let pendingText = "";

		const titlePrefix = "╭─";
		const titleText = ` ${truncateTerminalText(label, Math.max(5, contentWidth - 3))} `;
		const titleFill = Math.max(1, contentWidth + 4 - terminalTextWidth(titlePrefix) - terminalTextWidth(titleText) - 1);
		uiPrint(`${uiText(titlePrefix, "cyan")}${uiText(titleText, "magenta", true)}${uiText("─".repeat(titleFill) + "╮", "cyan")}`);

		function startLine() {
			stdout.write(`${uiText("│", "cyan")}${backgroundStyle} `);
			if (activeStyle) stdout.write(activeStyle);
			lineStarted = true;
		}

		function padLine() {
			const padding = Math.max(0, contentWidth - lineWidth) + 1;
			if (getUseColor()) stdout.write(`\u001b[0m${backgroundStyle}${" ".repeat(padding)}`);
			else stdout.write(" ".repeat(padding));
		}

		function finishLine() {
			if (!lineStarted) startLine();
			padLine();
			stdout.write(`${uiText("│", "cyan")}\n`);
			lineWidth = 0;
			lineStarted = false;
		}

		function emitCluster(cluster) {
			const characterWidth = terminalCharacterWidth(cluster);
			if (lineWidth > 0 && lineWidth + characterWidth > contentWidth) finishLine();
			if (!lineStarted) startLine();
			stdout.write(cluster);
			lineWidth += characterWidth;
		}

		function flushPendingText() {
			if (pendingText) emitCluster(pendingText);
			pendingText = "";
		}

		return {
			write(value) {
				const tokens = String(value).match(/\u001b\[[0-9;]*m|[\s\S]/gu) ?? [];
				for (const token of tokens) {
					if (token.startsWith("\u001b[")) {
						flushPendingText();
						if (token === "\u001b[0m") {
							activeStyle = "";
							stdout.write(`${token}${backgroundStyle}`);
						} else {
							activeStyle = token;
							stdout.write(token);
						}
						continue;
					}
					if (token === "\n") {
						flushPendingText();
						finishLine();
						continue;
					}
					const clusters = graphemes(pendingText + token);
					for (const cluster of clusters.slice(0, -1)) emitCluster(cluster);
					pendingText = clusters.at(-1) ?? "";
				}
			},
			close(status = "complete") {
				flushPendingText();
				if (lineStarted) finishLine();
				const footerPrefix = "╰─";
				const footerText = ` ${status} `;
				const footerFill = Math.max(1, contentWidth + 4 - terminalTextWidth(footerPrefix) - terminalTextWidth(footerText) - 1);
				uiPrint(`${uiText(footerPrefix, "cyan")}${uiText(footerText, "muted")}${uiText("─".repeat(footerFill) + "╯", "cyan")}`);
			},
		};
	}

	function createStreamingOutput(label) {
		let opened = false;
		let wroteOutput = false;
		let renderer;
		let bubbleWriter;
		return {
			write(chunk) {
				if (!opened) {
					print("");
					bubbleWriter = createAssistantBubbleWriter(label);
					renderer = new MarkdownTerminalRenderer((value) => bubbleWriter.write(value));
					opened = true;
				}
				renderer.write(chunk);
				wroteOutput = true;
			},
			close(status = "complete") {
				if (!opened) return;
				renderer.end();
				bubbleWriter.close(status);
				opened = false;
			},
			get opened() {
				return opened;
			},
			get hasOutput() {
				return wroteOutput;
			},
		};
	}

	function createReasoningStreamingOutput() {
		let wroteOutput = false;
		let lastCharacter = "";
		return {
			write(chunk) {
				const text = safeTerminalText(chunk);
				if (!text) return;
				if (!wroteOutput) {
					print("");
					wroteOutput = true;
				}
				stdout.write(uiText(text, "muted"));
				if (text) lastCharacter = text.at(-1);
			},
			close() {
				if (wroteOutput && lastCharacter !== "\n") stdout.write("\n");
				wroteOutput = false;
				lastCharacter = "";
			},
		};
	}
	return { createStreamingOutput, createReasoningStreamingOutput };
}
