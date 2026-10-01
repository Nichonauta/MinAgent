export function compactionBudget(contextWindow) {
	return {
		reserve: Math.min(16384, Math.floor(contextWindow / 4)),
		keepRecent: Math.min(20000, Math.floor(contextWindow / 4)),
	};
}

export function estimateTextTokens(value) {
	return Math.ceil(Buffer.byteLength(String(value ?? ""), "utf8") / 3);
}

export function textContent(content, imagePlaceholder = "") {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (part?.type === "text") return part.text ?? "";
		if (part?.type === "image_url") return imagePlaceholder;
		return "";
	}).filter(Boolean).join("\n");
}

export function estimateMessageTokens(message, imageTokenEstimate = 4800) {
	let text = "";
	let images = 0;
	if (typeof message.content === "string") text += message.content;
	else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part?.type === "text") text += String(part.text ?? "");
			else if (part?.type === "image_url") images += 1;
		}
	}
	if (Array.isArray(message.tool_calls)) text += JSON.stringify(message.tool_calls);
	return estimateTextTokens(text) + images * imageTokenEstimate;
}

export function serializeForSummary(conversationMessages) {
	return conversationMessages.map((message) => {
		let content = textContent(message.content, "[image attached]");
		if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
			const calls = message.tool_calls.map((call) => {
				let argumentsText = call?.function?.arguments ?? "";
				if (typeof argumentsText !== "string") argumentsText = JSON.stringify(argumentsText);
				if (argumentsText.length > 2000) {
					try {
						const args = JSON.parse(argumentsText);
						argumentsText = JSON.stringify(args, (_key, value) => typeof value === "string" && value.length > 600 ? `${value.slice(0, 250)}\n[Argument content omitted: ${value.length} characters]\n${value.slice(-250)}` : value);
					} catch { argumentsText = `${argumentsText.slice(0, 900)} [Invalid/long arguments omitted] ${argumentsText.slice(-900)}`; }
				}
				if (argumentsText.length > 2400) argumentsText = `${argumentsText.slice(0, 1100)} [Middle of argument data omitted] ${argumentsText.slice(-1100)}`;
				return `${call?.function?.name ?? "tool"}(${argumentsText})`;
			});
			content += `${content ? "\n" : ""}[Tool calls: ${calls.join("; ")}]`;
		}
		if (message.role === "tool" && content.length > 2400) {
			const headerEnd = content.startsWith("Tool result: ") ? content.indexOf("\n") : -1;
			const header = headerEnd >= 0 ? content.slice(0, headerEnd + 1) : "";
			const body = headerEnd >= 0 ? content.slice(headerEnd + 1) : content;
			content = `${header}${body.slice(0, 1000)}\n[Middle of tool result omitted for compaction.]\n${body.slice(-1000)}`;
		}
		return `[${message.role}] ${content}`;
	}).join("\n\n");
}

export function chunkSummaryTranscript(conversationMessages, maxChars) {
	if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new Error("Summary chunk size must be at least 256 characters.");
	const chunks = [];
	let current = "";
	for (const message of conversationMessages) {
		let remaining = serializeForSummary([message]);
		while (remaining) {
			const separator = current ? "\n\n" : "";
			const available = maxChars - current.length - separator.length;
			if (available <= 0) {
				chunks.push(current);
				current = "";
				continue;
			}
			const part = remaining.slice(0, available);
			current += separator + part;
			remaining = remaining.slice(part.length);
			if (remaining) {
				chunks.push(current);
				current = "";
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

export function findCompactionCutPoint(conversationMessages, keepRecentTokens, imageTokenEstimate = 4800) {
	const cutPoints = [];
	for (let index = 0; index < conversationMessages.length; index += 1) {
		const message = conversationMessages[index];
		// Assistant tool-call messages are valid boundaries because their tool
		// results remain after them. The search below prefers a later completed
		// assistant message when an oversized tool round should be summarized.
		if (message.role === "user" || message.role === "assistant") cutPoints.push(index);
	}
	if (cutPoints.length === 0) return 0;
	let accumulatedTokens = 0;
	let crossedIndex = -1;
	for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
		accumulatedTokens += estimateMessageTokens(conversationMessages[index], imageTokenEstimate);
		if (accumulatedTokens >= keepRecentTokens) {
			crossedIndex = index;
			break;
		}
	}
	if (crossedIndex < 0) return 0;

	// Prefer the next completed-turn boundary after the budget is reached. This
	// lets compaction discard a very large tool call and its results together,
	// instead of retaining that oversized message just because it crossed the
	// recent-history budget. If there is no later boundary, keep the nearest
	// valid boundary at or after the crossing point.
	return cutPoints.find((candidate) => candidate > crossedIndex)
		?? cutPoints.find((candidate) => candidate >= crossedIndex)
		?? cutPoints.at(-1);
}

export function pruneToolHistory(messages, keepRecentResults = 4) {
	let retained = 0;
	let removed = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "tool" || typeof message.content !== "string") continue;
		if (++retained <= keepRecentResults || message.content.length < 3000) continue;
		const newline = message.content.indexOf("\n");
		if (!message.content.startsWith("Tool result: ") || newline < 0) continue;
		let metadata;
		try { metadata = JSON.parse(message.content.slice(13, newline)); } catch { continue; }
		if (!["read_file", "list_directory", "search_files"].includes(metadata.tool) || metadata.status === "error") continue;
		message.content = `${message.content.slice(0, newline)}\n[Old inspection content omitted to fit the work budget. Use read_file/list_directory/search_files to recover evidence when needed.]\n${message.content.slice(-500)}`;
		removed += 1;
	}
	return removed;
}
