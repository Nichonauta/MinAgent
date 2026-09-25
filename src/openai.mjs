const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024;
const RETRYABLE_NETWORK_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

export function createOpenAiClient({ endpoint, apiKey, model, tools, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
	if (!endpoint || !model || !Array.isArray(tools)) throw new Error("OpenAI client configuration is incomplete.");
	return {
		complete: async (requestMessages, options = {}) => {
			const headers = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const requestBody = { model, messages: requestMessages, stream: true };
			if (options.withTools) {
				requestBody.tools = options.availableTools ?? tools;
				requestBody.tool_choice = options.toolChoice ?? "auto";
			}
			if (options.maxTokens) requestBody.max_tokens = options.maxTokens;
			const signals = [];
			if (options.signal) signals.push(options.signal);
			if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			let response;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					response = await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
						redirect: "error",
						signal,
					});
					break;
				} catch (error) {
					if (options.signal?.aborted) throw error;
					const code = error?.cause?.code;
					if (attempt === 0 && RETRYABLE_NETWORK_ERRORS.has(code)) {
						await waitForRetryDelay(options.signal);
						continue;
					}
					const cause = code ? ` (${code})` : error?.cause?.message ? ` (${error.cause.message})` : "";
					throw new Error(`Could not connect to the OpenAI-compatible endpoint: ${error.message}${cause}`);
				}
			}
			if (!response.ok) {
				const bodyText = await readResponsePrefix(response, 8 * 1024, options.signal);
				throw new Error(`Endpoint returned HTTP ${response.status}: ${bodyText}`);
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (contentType.includes("text/event-stream")) {
				return readStreamingResponse(response, options.onTextDelta, maxResponseBytes, options.onReasoningDelta, options.signal);
			}
			const bodyText = await readResponsePrefix(response, 2 * 1024, options.signal);
			throw new Error(`The endpoint did not return a streaming response (Content-Type: ${contentType || "unknown"}). Response: ${bodyText}`);
		},
	};
}

function waitForRetryDelay(signal) {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, 250));
	if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 250);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function readResponsePrefix(response, maxBytes, signal) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		while (totalBytes < maxBytes) {
			const { value, done } = await reader.read();
			if (done) break;
			const keep = value.subarray(0, maxBytes - totalBytes);
			chunks.push(Buffer.from(keep));
			totalBytes += keep.byteLength;
			if (keep.byteLength < value.byteLength) {
				truncated = true;
				break;
			}
		}
		if (totalBytes >= maxBytes) truncated = true;
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	return `${Buffer.concat(chunks, totalBytes).toString("utf8")}${truncated ? " [response excerpt truncated]" : ""}`;
}

export async function readStreamingResponse(response, onTextDelta, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, onReasoningDelta, signal) {
	if (!response.body) throw new Error("Endpoint opened a streaming response without a readable body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const toolCalls = new Map();
	let buffer = "";
	let content = "";
	let usage;
	let finishReason;
	let finished = false;
	let bytesRead = 0;
	let bodyDone = false;
	let interrupted = false;

	function consumeFrame(frame) {
		const data = frame.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") {
			if (data === "[DONE]") finished = true;
			return;
		}
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			throw new Error("Endpoint sent an invalid streaming event.");
		}
		if (event?.error) {
			const detail = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
			throw new Error(`Endpoint streaming error: ${detail.slice(0, 1000)}`);
		}
		if (event?.usage) usage = event.usage;
		const choice = event?.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta ?? {};
		const reasoningDelta = typeof delta.reasoning_summary === "string" && delta.reasoning_summary
			? delta.reasoning_summary
			: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
		if (reasoningDelta) {
			onReasoningDelta?.(reasoningDelta);
		}
		if (typeof delta.content === "string" && delta.content) {
			content += delta.content;
			onTextDelta?.(delta.content);
		} else if (Array.isArray(delta.content)) {
			for (const part of delta.content) {
				if (typeof part?.text === "string" && part.text) {
					content += part.text;
					onTextDelta?.(part.text);
				}
			}
		}
		for (const deltaCall of delta.tool_calls ?? []) {
			const index = Number.isInteger(deltaCall.index) ? deltaCall.index : toolCalls.size;
			const call = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
			if (deltaCall.id) call.id = deltaCall.id;
			if (deltaCall.type) call.type = deltaCall.type;
			if (deltaCall.function?.name) call.function.name += deltaCall.function.name;
			if (deltaCall.function?.arguments) {
				call.function.arguments += deltaCall.function.arguments;
				if (call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Endpoint returned tool arguments larger than the 1 MiB limit.");
			}
			toolCalls.set(index, call);
		}
	}

	try {
		while (!finished) {
			const { value, done } = await reader.read();
			if (done) {
				bodyDone = true;
				break;
			}
			bytesRead += value.byteLength;
			if (bytesRead > maxResponseBytes) throw new Error(`Endpoint streaming response exceeds the ${maxResponseBytes} byte limit.`);
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				consumeFrame(frame);
				if (finished) break;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) consumeFrame(buffer);
		if (!finished && !finishReason) throw new Error("Endpoint stream ended before a complete response was received.");
	} catch (error) {
		if (signal?.aborted) interrupted = true;
		else throw error;
	} finally {
		if (!bodyDone) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (interrupted) {
		return {
			payload: { usage, finish_reason: "aborted" },
			message: { role: "assistant", content: content || null, interrupted: true },
		};
	}

	const message = { role: "assistant", content: content || null };
	if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call]) => call);
	if (finishReason === "length") throw new Error("Endpoint stopped at its output token limit; the partial response was discarded.");
	if (finishReason === "content_filter") throw new Error("Endpoint stopped the response because of its content filter.");
	for (const call of message.tool_calls ?? []) {
		if (!call.id || !call.function.name) throw new Error("Endpoint returned an incomplete tool call.");
		try {
			const args = JSON.parse(call.function.arguments);
			if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
		} catch {
			throw new Error(`Endpoint returned invalid arguments for tool ${call.function.name}.`);
		}
	}
	return { payload: { usage, finish_reason: finishReason }, message };
}
