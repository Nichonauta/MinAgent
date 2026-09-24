const MAX_AUTOCOMPLETE_CANDIDATES = 1000;

function insertNewline(terminal) {
	if (typeof terminal?.line !== "string") return;
	const cursor = Number.isInteger(terminal.cursor) ? Math.max(0, Math.min(terminal.cursor, terminal.line.length)) : terminal.line.length;
	terminal.line = `${terminal.line.slice(0, cursor)}\n${terminal.line.slice(cursor)}`;
	terminal.cursor = cursor + 1;
	const multilineState = Object.getOwnPropertySymbols(terminal).find((symbol) => symbol.description === "_isMultiline");
	if (multilineState) terminal[multilineState] = true;
	terminal.prompt(true);
}

function suppressReadlineKey(key) {
	if (!key || typeof key !== "object") return;
	key.name = "j";
	key.ctrl = true;
	key.meta = false;
}

function isBulkInputChunk(terminal) {
	if (terminal?.isCompletionEnabled === false) return true;
	const sawKeyPress = Object.getOwnPropertySymbols(terminal ?? {}).find((symbol) => symbol.description === "_sawKeyPress");
	return Boolean(sawKeyPress && terminal[sawKeyPress] === false);
}

function clearPendingLineFeed(state) {
	state.skipNextLineFeed = false;
	if (state.lineFeedTimer) clearTimeout(state.lineFeedTimer);
	state.lineFeedTimer = undefined;
}

export function handlePastedInput(key, character, terminal, state) {
	state.bulkInputChunk = isBulkInputChunk(terminal);
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
			end: cursor,
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
		end: cursor,
		query,
		trailingSpace: rawQuery.length > query.length,
		candidates,
		totalMatches: ranked.totalMatches,
		selectedIndex: 0,
	};
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
