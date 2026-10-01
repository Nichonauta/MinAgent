export function modelsEndpoint(endpoint) {
	const url = new URL(endpoint);
	if (!/\/chat\/completions\/?$/.test(url.pathname)) throw new Error("Cannot derive the model catalog URL from this endpoint.");
	url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
	return url.toString();
}

export function normalizeModelCatalog(payload) {
	if (!Array.isArray(payload?.data)) throw new Error("The model catalog must contain a data array.");
	const models = new Map();
	for (const entry of payload.data) {
		if (typeof entry?.id !== "string" || !entry.id.trim() || /[\u0000-\u001f\u007f]/.test(entry.id)) continue;
		if (!models.has(entry.id)) models.set(entry.id, entry);
	}
	if (!models.size) throw new Error("The API returned no available model identifiers.");
	return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function modelSettings(entry, defaults, messages = []) {
	if (entry.capabilities?.tools === false) throw new Error("This model declares that it does not support tools.");
	const context = entry.context_window ?? entry.context_length;
	const knownContext = Number.isSafeInteger(context) && context > 0;
	const modalities = entry.input_modalities ?? entry.architecture?.input_modalities;
	const knownInput = Array.isArray(modalities) && modalities.includes("text") && modalities.every((item) => typeof item === "string");
	const inputModalities = knownInput ? [...new Set(modalities.filter((item) => ["text", "image"].includes(item)))] : [...defaults.inputModalities];
	if (!inputModalities.includes("image") && messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))) {
		throw new Error("The conversation contains images, but this model accepts text only. Use /new before switching.");
	}
	return { contextWindow: knownContext ? context : defaults.contextWindow, inputModalities, knownContext, knownInput };
}
