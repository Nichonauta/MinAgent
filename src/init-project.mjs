import { relative, sep } from "node:path";
import { redactLikelySecrets } from "./secrets.mjs";
import { INIT_PROMPT, INIT_RESEARCH_PROMPT } from "./prompts.mjs";
import { estimateMessageTokens, estimateTextTokens, textContent } from "./context.mjs";
import { MAX_TOOL_CALLS, parseToolArguments, toolEnvelope } from "./agent-runtime.mjs";
import { MAX_READ_OUTPUT_BYTES } from "./workspace.mjs";
import { EXCLUDED_DIRECTORIES } from "./workspace-policy.mjs";

const ROOT_EVIDENCE_FILES = /^(?:readme(?:\..+)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|composer\.json|gemfile|makefile|cmakelists\.txt|build\.gradle(?:\.kts)?|contributing(?:\..+)?|claude\.md|\.cursorrules|opencode\.json)$/i;
const PROJECT_DIRECTORIES = new Set(["src", "app", "lib", "cmd", "server", "client", "packages", "apps", "pages", "api", "web", "backend", "frontend", "tests", "test", "__tests__"]);
const SOURCE_EXTENSIONS = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|php|py|rb|rs|sh|sql|swift|ts|tsx|vue|svelte|html|css)$/i;

export async function investigateAndInitialize({ workspace, workspaceName, tools, complete, signal, focus = "", maxInputTokens = 48_000, maxRounds = 16, onPhase = () => {}, onToolStart = () => {}, onToolFinish = () => {} }) {
	const allowedTools = tools.filter((tool) => ["list_directory", "read_file", "search_files"].includes(tool.function?.name));
	const evidence = [];
	const inspected = new Set();
	const listed = new Map();
	const required = new Set();
	let sourceFound = false;
	let sourceRead = false;
	const checkAbort = () => signal?.throwIfAborted();
	const checkBudget = (messages) => {
		const tokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + estimateTextTokens(JSON.stringify(allowedTools));
		if (tokens > maxInputTokens) throw new Error("/init investigation exceeded its context budget; AGENTS.md was not changed. Retry with a narrower focus or larger context window.");
	};
	const inspect = async (name, args) => {
		checkAbort();
		onToolStart(name, args);
		let result;
		try {
			if (!["list_directory", "read_file", "search_files"].includes(name)) throw new Error("/init investigation permits only list_directory, read_file, and search_files.");
			const path = args.path ?? ".";
			const target = workspace.resolvePath(path); // Unlike normal reading, /init cannot open outside files.
			const normalized = relative(workspace.rootDirectory, target).split(sep).join("/") || ".";
			if (normalized.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) throw new Error("Generated and repository metadata directories are excluded from /init.");
			if (name === "read_file" && normalized.split("/").some((part) => (part.toLowerCase().startsWith(".env") && part.toLowerCase() !== ".env.example") || /(?:secret|credential|private[-_.]?key)/i.test(part))) throw new Error("Credential files are excluded from /init.");
			result = name === "list_directory" ? await workspace.listDirectory(args) : name === "search_files" ? await workspace.searchFiles(args, { signal }) : await workspace.readFileDetailed(args, { maxOutputBytes: Math.min(MAX_READ_OUTPUT_BYTES, Math.max(512, Math.floor(maxInputTokens * 0.75))) });
			checkAbort();
			result = { ...result, toolText: redactLikelySecrets(result.toolText) };
			if (name === "list_directory") {
				const info = result.directoryInfo;
				if (!info) throw new Error("Directory evidence metadata is missing.");
				listed.set(normalized, info);
				for (const entry of info.entries) {
					const path = normalized === "." ? entry.name : `${normalized}/${entry.name}`;
					if (entry.kind === "file" && SOURCE_EXTENSIONS.test(entry.name)) sourceFound = true;
					if (normalized === "." && entry.kind === "file" && (ROOT_EVIDENCE_FILES.test(entry.name) || REQUIRED_CONFIG_FILES.has(entry.name.toLowerCase()))) required.add(path);
				}
			} else if (name === "read_file") {
				const info = result.readInfo;
				if (!info) throw new Error("Text reading evidence metadata is missing.");
				inspected.add(normalized);
				if (SOURCE_EXTENSIONS.test(normalized)) sourceRead = true;
			}
			evidence.push({ tool: name, path: normalized, read: result.readInfo, directory: result.directoryInfo, search: result.searchInfo });
		} catch (error) {
			checkAbort();
			result = { isError: true, toolText: `Error: ${redactLikelySecrets(error.message)}`, displayText: error.message };
			evidence.push({ tool: name, path: args.path, error: result.toolText });
		}
		onToolFinish(name, args, result);
		return result;
	};

	onPhase("Listing workspace");
	const root = await inspect("list_directory", { path: "." });
	if (root.isError) throw new Error("/init could not list the workspace; AGENTS.md was not changed.");
	checkAbort();
	const initialState = await workspace.fileState("AGENTS.md");
	if (initialState && Buffer.byteLength(initialState.content, "utf8") > 64 * 1024) throw new Error("Existing AGENTS.md exceeds 64 KiB; it was not changed.");
	if (initialState) {
		onPhase("Reading existing AGENTS.md");
		const existing = await inspect("read_file", { path: "AGENTS.md" });
		if (existing.isError) throw new Error("/init could not read existing AGENTS.md; it was not changed.");
	}
	const research = [
		{ role: "system", content: INIT_RESEARCH_PROMPT },
		{ role: "user", content: JSON.stringify({ workspace: workspaceName, focus, rootListing: root.toolText, existingAgentsMd: initialState ? redactLikelySecrets(initialState.content) : null }) },
	];
	const missingEvidence = () => {
		const missing = [...required].filter((path) => !inspected.has(path));
		const rootInfo = listed.get(".");
		if (rootInfo.truncated) missing.push("complete the root listing with a larger limit");
		const projectEntries = rootInfo.entries.filter((entry) => entry.name.toLowerCase() !== "agents.md" && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()));
		if (projectEntries.length && ![...inspected].some((path) => path.toLowerCase() !== "agents.md")) missing.push("read at least one relevant project file");
		const projectDirectories = projectEntries.filter((entry) => entry.kind === "directory" && PROJECT_DIRECTORIES.has(entry.name.toLowerCase()));
		if (projectDirectories.length && !projectDirectories.some((entry) => listed.has(entry.name))) missing.push("list a relevant project subdirectory");
		if (sourceFound && !sourceRead) missing.push("read representative source/test code");
		return missing;
	};
	let ready = false;
	let prematureResponses = 0;
	for (let round = 0; round < maxRounds; round += 1) {
		checkAbort();
		checkBudget(research);
		onPhase("Inspecting project files");
		const response = await complete(research, { withTools: true, availableTools: allowedTools, signal, maxTokens: 2048 });
		checkAbort();
		if (response.message?.interrupted) throw new Error("/init investigation was interrupted; AGENTS.md was not changed.");
		const message = response.message;
		if (!message) throw new Error("/init received no investigation response.");
		const calls = message.tool_calls ?? [];
		if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS) throw new Error("/init received too many or invalid tool calls; none were executed.");
		research.push({ role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
		if (!calls.length) {
			const missing = missingEvidence();
			if (!missing.length && textContent(message.content).trim()) { ready = true; break; }
			if (prematureResponses++ >= 1) throw new Error(`/init investigation is incomplete (${missing.join("; ") || "empty findings"}); AGENTS.md was not changed.`);
			research.push({ role: "user", content: `Evidence still needed: ${missing.join("; ") || "summarize supported findings"}. Continue listing/reading before drafting; invent nothing.` });
			continue;
		}
		for (const call of calls) {
			checkAbort();
			let result;
			let args = {};
			try {
				args = parseToolArguments(call.function?.arguments);
				result = await inspect(call.function?.name, args);
			} catch (error) {
				checkAbort();
				result = { isError: true, toolText: `Error: ${error.message}` };
				onToolFinish(call.function?.name, {}, result);
			}
			research.push({ role: "tool", tool_call_id: call.id, content: toolEnvelope(call.function?.name, args, result).content });
			checkBudget(research);
		}
	}
	if (!ready) throw new Error("/init reached its investigation round limit; AGENTS.md was not changed.");
	const generation = [{ role: "system", content: INIT_PROMPT }, ...research.slice(1), { role: "user", content: "Write the complete AGENTS.md from investigated evidence; state material limitations." }];
	checkBudget(generation);
	checkAbort();
	onPhase(`Generating AGENTS.md from ${inspected.size} inspected files`);
	const generated = await complete(generation, { signal, maxTokens: 4096 });
	checkAbort();
	if (generated.message?.interrupted || generated.message?.tool_calls?.length) throw new Error("/init generation did not finish a document; AGENTS.md was not changed.");
	const content = textContent(generated.message?.content).trim().replace(/^```(?:markdown|md)?\s*\n/i, "").replace(/\n```\s*$/, "").trim();
	if (!content) throw new Error("The model returned an empty AGENTS.md; the file was not changed.");
	if (!/^#{1,6}\s+\S/m.test(content)) throw new Error("The generated AGENTS.md has no Markdown heading; the file was not changed.");
	checkAbort();
	onPhase("Saving AGENTS.md");
	await workspace.writeFile({ path: "AGENTS.md", content: `${redactLikelySecrets(content)}\n` }, { expectedState: initialState, signal });
	return { action: initialState ? "updated" : "created", inspectedFiles: inspected.size, evidence };
}

const REQUIRED_CONFIG_FILES = new Set([
	"requirements.txt", "tsconfig.json", "dockerfile",
	"vite.config.js", "vite.config.mjs", "vite.config.ts",
	"next.config.js", "next.config.mjs", "next.config.ts",
]);
