import { insertNewline, isBulkInputChunk } from "./readline-adapter.mjs";
import { safeTerminalText, truncateTerminalText } from "./terminal-text.mjs";

const MAX_AUTOCOMPLETE_CANDIDATES = 1000;
export const AUTOCOMPLETE_PANEL_ROWS = 7;
const AUTOCOMPLETE_MAX_ITEMS = AUTOCOMPLETE_PANEL_ROWS - 2;
const NAVIGATION_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown", "delete", "backspace", "escape"]);

export function formatAutocompletePanel(state, { columns = 80, useColor = false, uiText = (value) => value } = {}) {
	const title = state.kind === "file" ? "Files" : "Commands";
	const lines = [uiText(`  ┌─ ${title.toUpperCase()} · ${state.totalMatches} match${state.totalMatches === 1 ? "" : "es"}`, state.kind === "file" ? "cyan" : "magenta", true)];
	const firstVisibleIndex = Math.max(0, Math.min(
		state.selectedIndex - Math.floor(AUTOCOMPLETE_MAX_ITEMS / 2),
		state.candidates.length - AUTOCOMPLETE_MAX_ITEMS,
	));
	for (let visibleIndex = 0; visibleIndex < AUTOCOMPLETE_MAX_ITEMS; visibleIndex += 1) {
		const index = firstVisibleIndex + visibleIndex;
		const candidate = state.candidates[index];
		if (!candidate) {
			lines.push("");
			continue;
		}
		const marker = index === state.selectedIndex ? "›" : " ";
		const label = safeTerminalText(candidate.label).replace(/\s+/g, " ");
		const shown = truncateTerminalText(label, Math.max(1, columns - 6));
		const option = `  ${marker} ${shown}`;
		lines.push(index === state.selectedIndex
			? (useColor ? `\u001b[48;2;32;93;112;38;2;226;239;241m${safeTerminalText(option)}\u001b[0m` : option)
			: uiText(option, "muted"));
	}
	lines.push(uiText("  └─ ↑/↓ select · Enter complete · Esc close", "muted"));
	return lines;
}

function suppressReadlineKey(key) {
	if (!key || typeof key !== "object") return;
	key.name = "j";
	key.ctrl = true;
	key.meta = false;
}

function clearPendingLineFeed(state) {
	state.skipNextLineFeed = false;
	if (state.lineFeedTimer) clearTimeout(state.lineFeedTimer);
	state.lineFeedTimer = undefined;
}

export function handlePastedInput(key, character, terminal, state) {
	// Readline marks escape sequences as bulk chunks before its own keypress listener runs.
	// Arrow keys are still single physical keypresses and must reach autocomplete.
	state.bulkInputChunk = !NAVIGATION_KEYS.has(key?.name) && isBulkInputChunk(terminal);
	if (key?.name === "paste-start") {
		state.active = true;
		clearPendingLineFeed(state);
		key.name = "unbound";
		return true;
	}
	if (key?.name === "paste-end") {
		state.active = false;
		clearPendingLineFeed(state);
		key.name = "unbound";
		return true;
	}
	if (!state.active && !state.bulkInputChunk) return false;

	if (character === "\r") {
		insertNewline(terminal);
		state.skipNextLineFeed = true;
		if (state.lineFeedTimer) clearTimeout(state.lineFeedTimer);
		state.lineFeedTimer = setTimeout(() => clearPendingLineFeed(state), 100);
		suppressReadlineKey(key);
		return true;
	}
	if (character === "\n") {
		if (!state.skipNextLineFeed) insertNewline(terminal);
		clearPendingLineFeed(state);
		suppressReadlineKey(key);
		return true;
	}
	if (state.skipNextLineFeed) clearPendingLineFeed(state);
	return true;
}

export function handleControlJInput(key, character, terminal) {
	const isControlJ = (key?.ctrl && key.name === "j")
		|| (character === "\n" && key?.sequence === "\n" && key.name === "enter" && !key.ctrl && !key.meta);
	if (!isControlJ) return false;

	insertNewline(terminal);

	// readline otherwise treats the LF character as Enter and submits the line.
	key.name = "j";
	key.ctrl = true;
	key.meta = false;
	return true;
}

export function buildAutocompleteState(line, cursor, workspaceFiles, slashCommands) {
	const prefix = line.slice(0, cursor);
	const tokenEnd = cursor + (line.slice(cursor).match(/^[^\s]*/)?.[0].length ?? 0);
	const commandMatch = prefix.match(/^(\s*)\/([^\s]*)$/);
	if (commandMatch) {
		const query = commandMatch[2].toLowerCase();
		const candidates = slashCommands
			.filter((command) => command.name.startsWith(query) && command.name !== query)
			.map((command) => ({ value: `/${command.name}`, label: `/${command.name}  ${command.description}` }));
		if (candidates.length === 0) return null;
		return {
			kind: "command",
			line,
			cursor,
			start: commandMatch[1].length,
			end: tokenEnd,
			query,
			candidates,
			totalMatches: candidates.length,
			selectedIndex: 0,
		};
	}

	const atIndex = prefix.lastIndexOf("@");
	if (atIndex < 0 || (atIndex > 0 && !/\s/.test(prefix[atIndex - 1]))) return null;
	const rawQuery = prefix.slice(atIndex + 1);
	const query = rawQuery.trimEnd();
	const ranked = rankWorkspaceFiles(query, workspaceFiles);
	if (ranked.paths.length === 0) return null;
	const candidates = ranked.paths.map((path) => ({ value: path, label: path }));
	return {
		kind: "file",
		line,
		cursor,
		start: atIndex,
		end: tokenEnd,
		query,
		trailingSpace: rawQuery.length > query.length,
		candidates,
		totalMatches: ranked.totalMatches,
		selectedIndex: 0,
	};
}

export function handleAutocompleteKeypress(state, key, terminal) {
	if (!state?.candidates.length || !key || terminal.line !== state.line || terminal.cursor !== state.cursor) return null;
	if (key.name === "up" || key.name === "down") {
		const direction = key.name === "up" ? -1 : 1;
		suppressReadlineKey(key);
		state.selectedIndex = (state.selectedIndex + direction + state.candidates.length) % state.candidates.length;
		return { kind: "move" };
	}
	if ((key.name !== "return" && key.name !== "enter") || key.ctrl || key.meta) return null;
	suppressReadlineKey(key);
	const selected = state.candidates[state.selectedIndex] ?? state.candidates[0];
	const replacement = state.kind === "file" && state.trailingSpace ? `${selected.value} ` : selected.value;
	terminal.line = `${state.line.slice(0, state.start)}${replacement}${state.line.slice(state.end)}`;
	terminal.cursor = state.start + replacement.length;
	return { kind: "complete", selectedFile: state.kind === "file" ? selected.value : null };
}

export function rankWorkspaceFiles(query, workspaceFiles) {
	const normalized = query.toLowerCase();
	const ranked = [];
	let totalMatches = 0;
	for (const path of workspaceFiles) {
		const lowerPath = path.toLowerCase();
		const fileName = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
		let score = 0;
		if (!normalized) score = 0;
		else if (fileName.startsWith(normalized)) score = 0;
		else if (lowerPath.startsWith(normalized)) score = 1;
		else if (fileName.includes(normalized)) score = 2 + fileName.indexOf(normalized) / 1000;
		else if (lowerPath.includes(normalized)) score = 3 + lowerPath.indexOf(normalized) / 1000;
		else {
			let queryIndex = 0;
			let gaps = 0;
			for (const character of lowerPath) {
				if (character === normalized[queryIndex]) queryIndex += 1;
				else if (queryIndex > 0) gaps += 1;
				if (queryIndex === normalized.length) break;
			}
			if (queryIndex !== normalized.length) continue;
			score = 10 + gaps;
		}
		totalMatches += 1;
		ranked.push({ path, score });
	}
	ranked.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
	return { paths: ranked.slice(0, MAX_AUTOCOMPLETE_CANDIDATES).map((entry) => entry.path), totalMatches };
}
