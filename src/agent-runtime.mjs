import { createHash } from "node:crypto";
import { redactLikelySecrets } from "./secrets.mjs";

const MUTATIONS = new Set(["edit_file", "write_file", "delete_file", "delete_directory", "run_terminal"]);
export const MAX_TOOL_CALLS = 16;
const failure = (code, message) => Object.assign(new Error(message), { code });

export function parseToolArguments(value) {
	const args = typeof value === "string" ? JSON.parse(value) : value;
	if (!args || typeof args !== "object" || Array.isArray(args)) throw failure("INVALID_ARGUMENTS", "Tool arguments must be a JSON object.");
	return args;
}

export function validateToolArguments(name, args, definitions, { strict = true } = {}) {
	const definition = definitions.find((tool) => tool.function?.name === name);
	if (!definition) throw failure("UNAVAILABLE_TOOL", `Tool '${name}' is unavailable. Choose an advertised tool.`);
	if (!args || typeof args !== "object" || Array.isArray(args)) throw failure("INVALID_ARGUMENTS", "Tool arguments must be a JSON object.");
	const schema = definition.function.parameters;
	// External JSON Schema dialects are owned by their server; validate local tools here.
	if (!strict) return args;
	for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw failure("INVALID_ARGUMENTS", `Missing required argument: ${key}.`);
	for (const [key, value] of Object.entries(args)) {
		const rule = schema.properties?.[key];
		if (!rule) throw failure("INVALID_ARGUMENTS", `Unknown argument: ${key}.`);
		const validType = rule.type === "integer" ? Number.isInteger(value) : rule.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === rule.type;
		if (rule.type && !validType) throw failure("INVALID_ARGUMENTS", `${key} must be ${rule.type}.`);
		if (rule.enum && !rule.enum.includes(value)) throw failure("INVALID_ARGUMENTS", `${key} must be one of ${rule.enum.join(", ")}.`);
		if ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum) || (rule.minLength !== undefined && value.length < rule.minLength)) throw failure("INVALID_ARGUMENTS", `${key} is outside the advertised limits.`);
	}
	return args;
}

export function toolEnvelope(name, args, result, error, { maxChars = 64000 } = {}) {
	let text = result && typeof result === "object" ? String(result.toolText ?? "") : String(result ?? "");
	const denied = /^(?:Permission denied by the user|MCP call denied by the user)/i.test(text);
	const exit = name === "run_terminal" ? text.match(/^Exit code: (.+)$/m)?.[1] : undefined;
	const isError = Boolean(error || result?.isError || /^Error:|^Could not start the command:/i.test(text) || (exit !== undefined && exit !== "0"));
	const status = denied ? "denied" : error?.name === "AbortError" ? "canceled" : isError ? "error" : result?.searchInfo?.status === "canceled" ? "canceled" : result?.searchInfo?.status === "incomplete" || result?.directoryInfo?.truncated || (result?.readInfo && !result.readInfo.reachedEndOfFile) ? "incomplete" : "success";
	const metadata = {
		tool: name, status,
		...(isError && !error ? { code: name === "run_terminal" ? "COMMAND_FAILED" : "TOOL_ERROR" } : {}),
		...(args.path !== undefined ? { path: args.path } : {}),
		...(error ? { code: error.code ?? "TOOL_ERROR", mayHaveChanged: Boolean(error.mayHaveChanged), nextAction: error.mayHaveChanged ? "Inspect current state before retrying; never automatically repeat this operation." : error.message } : {}),
		...(result?.readInfo ? { read: result.readInfo } : {}),
		...(result?.directoryInfo ? { directory: { path: result.directoryInfo.path, returnedEntries: result.directoryInfo.entries.length, truncated: result.directoryInfo.truncated } } : {}),
		...(result?.searchInfo ? { search: { ...result.searchInfo, results: undefined } } : {}),
		...(exit !== undefined ? { exitCode: exit, stopped: /command (?:was )?stopped|Command stopped/i.test(text) } : {}),
		...(MUTATIONS.has(name) ? { changed: isError ? (error?.mayHaveChanged ? "unknown" : name === "run_terminal" ? "unknown" : false) : denied ? false : name === "run_terminal" ? "unknown" : true } : {}),
	};
	// Exact file excerpts must be limited by the reader, before evidence is recorded.
	if (name !== "read_file" && text.length > maxChars) {
		const half = Math.max(128, Math.floor((maxChars - 160) / 2));
		text = `${text.slice(0, half)}\n[Middle of tool output omitted to fit the work budget; narrow the query or command for details.]\n${text.slice(-half)}`;
		metadata.outputTruncated = true;
		if (metadata.status === "success") metadata.status = "incomplete";
	}
	return { metadata, content: `Tool result: ${JSON.stringify(metadata)}\n${text}` };
}

export function createEvidenceLedger(workspace, { maxFiles = 64, maxEvidenceChars = 2_000_000 } = {}) {
	const files = new Map();
	const outcomes = [];
	let goal = "";
	const key = (path) => {
		const resolved = workspace.resolvePath(path, { allowOutside: true });
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const hash = (content) => createHash("sha256").update(content).digest("hex");
	return {
		begin(request) { goal = String(request).slice(0, 1500); },
		clear() { files.clear(); outcomes.length = 0; goal = ""; },
		invalidate() { files.clear(); },
		recordRead(path, result) {
			if (!result?.readState || !result.readInfo) return;
			const id = key(path);
			let file = files.get(id);
			if (!file || file.hash !== result.readState.hash) file = { path, hash: result.readState.hash, ranges: [], segments: [], full: false };
			const info = result.readInfo;
			const content = result.readContent;
			if (!file.full) {
				const fragment = content + (!info.partialLine && info.nextOffset !== undefined ? "\n" : "");
				const start = result.readState.start;
				const segments = [...(file.segments ?? []), { start, end: start + fragment.length, content: fragment }].sort((a, b) => a.start - b.start);
				const merged = [];
				for (const segment of segments) {
					const prior = merged.at(-1);
					if (prior && segment.start <= prior.end) {
						if (segment.end > prior.end) { prior.content += segment.content.slice(prior.end - segment.start); prior.end = segment.end; }
					} else merged.push({ ...segment });
				}
				file.segments = merged.slice(-16);
				file.ranges = file.segments.map((segment) => segment.content);
				file.full = file.segments.length === 1 && file.segments[0].start === 0 && file.segments[0].end === result.readState.length;
			}
			file.lastRead = info;
			files.delete(id);
			files.set(id, file);
			while (files.size > maxFiles) files.delete(files.keys().next().value);
			while ([...files.values()].reduce((sum, item) => sum + item.ranges.reduce((total, range) => total + range.length, 0), 0) > maxEvidenceChars) files.delete(files.keys().next().value);
		},
		async beforeMutation(name, args) {
			if (!["edit_file", "write_file"].includes(name)) return {};
			const state = await workspace.fileState(args.path);
			if (!state) {
				if (name === "write_file") return { expectedState: null };
				throw failure("MISSING_FILE", "The edit target does not exist. Locate and read the correct file.");
			}
			const file = files.get(key(args.path));
			if (!file || file.hash !== state.hash) throw failure("READ_REQUIRED", "Read the current target with read_file before modifying it; the file is unread or changed since inspection.");
			if (name === "write_file" && !file.full) throw failure("FULL_READ_REQUIRED", "Replacing an existing file requires a complete read from line 1. Prefer edit_file for a targeted change.");
			if (name === "edit_file" && !file.ranges.some((content) => content.includes(args.old_text))) throw failure("BLOCK_READ_REQUIRED", "Read the exact block to replace before editing it. Search snippets and unread text do not count.");
			return name === "edit_file" ? { expectedHash: state.hash } : { expectedState: state };
		},
		async recordMutation(name, args) {
			if (!["edit_file", "write_file"].includes(name)) return;
			const id = key(args.path);
			const previous = files.get(id);
			const full = name === "write_file" || previous?.full;
			const content = name === "write_file" ? args.content : full ? previous.ranges[0].replace(args.old_text, () => args.new_text) : args.new_text;
			const state = await workspace.fileState(args.path);
			if (!state || (full && state.hash !== hash(content)) || (!full && !state.content.includes(content))) { files.delete(id); return; }
			files.set(id, { path: args.path, hash: state.hash, full, ranges: [content], lastRead: previous?.lastRead, changed: true });
		},
		recordOutcome(metadata) {
			outcomes.push({ tool: metadata.tool, path: metadata.path, status: metadata.status, code: metadata.code, changed: metadata.changed, exitCode: metadata.exitCode });
			if (outcomes.length > 8) outcomes.shift();
		},
		snapshot() {
			return JSON.stringify({ goal: redactLikelySecrets(goal), files: [...files.values()].slice(-8).map(({ path, full, lastRead, changed }) => ({ path, completeRead: full, lastRead, changed })), recentResults: outcomes });
		},
	};
}

export async function executeRecordedTool(name, args, { ledger, definitions, isExternal = () => false, dispatch }) {
	validateToolArguments(name, args, definitions, { strict: !isExternal(name) });
	const guarded = await ledger.beforeMutation(name, args);
	const result = await dispatch(name, args, guarded);
	if (name === "read_file") ledger.recordRead(args.path, result);
	if (["edit_file", "write_file"].includes(name)) {
		try { await ledger.recordMutation(name, args); }
		catch (error) { ledger.invalidate(); error.mayHaveChanged = true; throw error; }
	}
	if (name === "delete_file" || name === "delete_directory") ledger.invalidate();
	return result;
}

export function createLoopGuard(limit = 2) {
	const seen = new Map();
	let progress = 0;
	const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
	return {
		check(name, args) {
			const id = JSON.stringify([name, stable(args)]);
			if ((seen.get(id)?.repetitions ?? 0) >= 3 && seen.get(id).progress === progress) throw failure("REPEATED_RESULT", "This call returned the same result repeatedly without progress. Continue to another range or choose a different approach.");
			if ((seen.get(id)?.failures ?? 0) >= limit && seen.get(id).progress === progress) throw failure("REPEATED_FAILURE", "This call repeatedly failed without new evidence. Read current state or choose a different approach.");
			return id;
		},
		record(id, metadata, content) {
			if (["error", "denied"].includes(metadata.status)) {
				const prior = seen.get(id);
				seen.set(id, { progress, failures: prior?.progress === progress ? prior.failures + 1 : 1 });
			} else {
				const signature = createHash("sha256").update(content).digest("hex");
				const prior = seen.get(id);
				if (prior?.signature !== signature) progress += 1;
				seen.set(id, { progress, failures: 0, signature, repetitions: prior?.signature === signature && prior.progress === progress ? prior.repetitions + 1 : 1 });
			}
		},
	};
}

export function preflightCalls(calls, definitions, isExternal = () => false) {
	if (!Array.isArray(calls)) throw failure("INVALID_ARGUMENTS", "Tool calls must be an array.");
	if (calls.length > MAX_TOOL_CALLS) throw failure("CALL_LIMIT", `Use at most ${MAX_TOOL_CALLS} tools in one response; no calls in this batch were executed.`);
	for (const call of calls) {
		const name = call.function?.name;
		const args = parseToolArguments(call.function?.arguments);
		validateToolArguments(name, args, definitions, { strict: !isExternal(name) });
	}
}
