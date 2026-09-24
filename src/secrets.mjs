const SECRET_ASSIGNMENT = /(^|[\s,{])([A-Za-z][A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gim;

function isSecretName(value) {
	const words = String(value)
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	return words.some((word) => ["token", "secret", "password", "passwd", "credential"].includes(word))
		|| words.some((word, index) => word === "key" && ["api", "access", "private", "client"].includes(words[index - 1]));
}

export function redactLikelySecrets(value) {
	let text = String(value ?? "");
	text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
	text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
	text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED TOKEN]");
	text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]");
	text = text.replace(SECRET_ASSIGNMENT, (match, prefix, assignment) => {
		const name = assignment.slice(0, assignment.search(/\s*[:=]/));
		return isSecretName(name) ? `${prefix}${assignment}[REDACTED]` : match;
	});
	return text;
}

export function approvalPreview(value, maxChars = 1200) {
	function mask(item, depth = 0) {
		if (depth > 8) return "[Nested value omitted]";
		if (Array.isArray(item)) return item.slice(0, 50).map((child) => mask(child, depth + 1));
		if (item && typeof item === "object") {
			return Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, child]) => [
				key,
				isSecretName(key) ? "[REDACTED]" : mask(child, depth + 1),
			]));
		}
		return item;
	}
	let preview;
	try {
		preview = JSON.stringify(mask(value));
	} catch {
		return "[Arguments could not be displayed]";
	}
	return preview.length > maxChars ? `${preview.slice(0, maxChars)}… [preview truncated]` : preview;
}
