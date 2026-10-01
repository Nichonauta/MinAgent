import { join, relative, sep } from "node:path";
import { setImmediate as yieldToInput } from "node:timers/promises";
import { redactLikelySecrets } from "./secrets.mjs";
import { EXCLUDED_DIRECTORIES } from "./workspace-policy.mjs";

const MAX_OUTPUT_BYTES = 48 * 1024;

export const searchTool = {
	type: "function",
	function: {
		name: "search_files",
		description: "Recursively search literal text in workspace filenames, UTF-8 contents, or both. Returns paths/matching lines, not full files; excludes generated directories and reports limits/omissions.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, description: "Single-line literal; no regex/glob" },
				mode: { type: "string", enum: ["filename", "content", "both"], default: "both" },
				path: { type: "string", description: "Workspace directory; default: root" },
				case_sensitive: { type: "boolean", default: false },
				limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
			},
			required: ["query"],
		},
	},
};

export async function searchWorkspace(workspace, args, { signal, maxEntries = 10_000, maxReadBytes = 64 * 1024 * 1024, timeoutMs = 15_000, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
	if (!args || typeof args.query !== "string" || !args.query.length || /[\r\n\0]/.test(args.query) || args.query.length > 4096) throw new Error("query must be non-empty single-line text of at most 4096 characters.");
	const mode = args.mode ?? "both";
	const limit = args.limit ?? 100;
	if (!["filename", "content", "both"].includes(mode)) throw new Error("mode must be filename, content, or both.");
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500.");
	if (args.case_sensitive !== undefined && typeof args.case_sensitive !== "boolean") throw new Error("case_sensitive must be a boolean.");
	const root = args.path ?? ".";
	const normalizedRoot = relative(workspace.rootDirectory, workspace.resolvePath(root)).split(sep).join("/");
	if (normalizedRoot.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) throw new Error("Search excludes generated and repository metadata directories.");
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const readSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const pattern = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), args.case_sensitive ? "u" : "iu");
	const results = [];
	const stats = { entriesExamined: 0, filesExamined: 0, filesRead: 0, bytesRead: 0, excludedDirectories: 0, linkedOrSpecial: 0, binaryOrInvalidText: 0, oversizedFiles: 0, errors: 0 };
	const errors = [];
	const reasons = new Set();
	const started = performance.now();
	let outputBytes = 0;
	let stopped = false;
	const check = () => {
		if (signal?.aborted) { reasons.add("canceled"); stopped = true; }
		if (timeoutSignal.aborted || performance.now() - started >= timeoutMs) { reasons.add("time limit"); stopped = true; }
		return stopped;
	};
	const add = (result) => {
		const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
		if (outputBytes + bytes > maxOutputBytes - 4096) { reasons.add("output limit"); stopped = true; return; }
		results.push(result);
		outputBytes += bytes;
		if (results.length >= limit) { reasons.add("result limit"); stopped = true; }
	};
	const reportError = (path, error) => {
		stats.errors += 1;
		if (errors.length < 5) errors.push({ path: path.slice(0, 300), error: redactLikelySecrets(String(error.message)).slice(0, 200) });
	};
	const stack = [{ directory: root }];
	while (stack.length && !check()) {
		const task = stack.pop();
		await yieldToInput();
		if (check()) break;
		if (task.directory !== undefined) {
			let listing;
			try { listing = await workspace.listDirectory({ path: task.directory, limit: 10_000 }); }
			catch (error) {
				if (task.directory === root) throw error;
				reportError(task.directory, error);
				continue;
			}
			const info = listing.directoryInfo;
			if (info.truncated) reasons.add("directory listing limit");
			for (const entry of [...info.entries].reverse()) {
				stack.push({ entry, path: info.path === "." ? entry.name : join(info.path, entry.name).split(sep).join("/") });
			}
			continue;
		}
		if (stats.entriesExamined >= maxEntries) { reasons.add("entry limit"); break; }
		stats.entriesExamined += 1;
		const { entry, path } = task;
		if (entry.kind === "directory") {
			if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) stats.excludedDirectories += 1;
			else stack.push({ directory: path });
			continue;
		}
		if (entry.kind !== "file") { stats.linkedOrSpecial += 1; continue; }
		stats.filesExamined += 1;
		if (mode !== "content" && pattern.test(entry.name)) add({ type: "filename", path });
		if (check() || mode === "filename") continue;
		let buffer;
		try { buffer = await workspace.readRawFile(path, { maxBytes: Math.min(10 * 1024 * 1024, maxReadBytes - stats.bytesRead), signal: readSignal }); }
		catch (error) {
			if (check()) break;
			if (error.code === "READ_SIZE_LIMIT") {
				if (error.byteSize > 10 * 1024 * 1024) { stats.oversizedFiles += 1; reasons.add("file size limit"); }
				else { reasons.add("read budget"); stopped = true; }
			} else reportError(path, error);
			continue;
		}
		stats.filesRead += 1;
		stats.bytesRead += buffer.length;
		if (check()) break;
		let text;
		try {
			if (buffer.includes(0)) throw new Error("binary");
			text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} catch { stats.binaryOrInvalidText += 1; continue; }
		const lines = text.split("\n");
		for (let index = 0; index < lines.length && !check(); index += 1) {
			if (index % 256 === 0) { await yieldToInput(); if (check()) break; }
			const line = lines[index].replace(/\r$/, "");
			const match = pattern.exec(line);
			if (!match) continue;
			// Redact the whole line before selecting a snippet, so assignments retain context.
			const safeLine = redactLikelySecrets(line);
			const center = Math.min(match.index, safeLine.length);
			const start = Math.max(0, center - 120);
			const snippet = `${start ? "…" : ""}${safeLine.slice(start, start + 400)}${safeLine.length > start + 400 ? "…" : ""}`;
			add({ type: "content", path, line: index + 1, column: [...line.slice(0, match.index)].length + 1, snippet });
		}
	}
	const incomplete = reasons.size > 0 || stats.errors > 0;
	const status = reasons.has("canceled") ? "canceled" : incomplete ? "incomplete" : "complete";
	const summary = `${results.length} results · ${stats.filesExamined} files examined · ${stats.filesRead} files read · ${status}`;
	const resultLines = results.map((result) => result.type === "filename" ? `[filename] ${JSON.stringify(result.path)}` : `[content] ${JSON.stringify(result.path)}:${result.line}:${result.column}\n  ${JSON.stringify(result.snippet)}`);
	const metadata = { status, reasons: [...reasons], stats, returnedResults: results.length, exclusions: [...EXCLUDED_DIRECTORIES], errors };
	return {
		toolText: `${summary}\n${resultLines.join("\n")}\nSearch metadata: ${JSON.stringify(metadata)}\nSearch snippets are not full-file reads; narrow path/query or use read_file for context.`,
		displayText: `${summary}${reasons.size ? ` (${[...reasons].join(", ")})` : ""}\n${resultLines.slice(0, 10).join("\n")}${results.length > 10 ? "\n[More results supplied to the model.]" : ""}`,
		searchInfo: { ...metadata, results },
	};
}
