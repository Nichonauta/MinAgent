#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { connectMcpServers, executeMcpTool, formatMcpContext } from "./mcp.mjs";
import { createSkillTools, discoverSkills, executeSkillTool, formatSkillContext } from "./skills.mjs";
import { loadConfiguration } from "./config.mjs";
import { createWorkspaceAccess, MAX_READ_LINES, MAX_READ_OUTPUT_BYTES } from "./workspace.mjs";
import { runTerminalCommand as executeTerminalCommand } from "./terminal-command.mjs";
import { requestToolPermission } from "./tool-permissions.mjs";
import { approvalPreview, redactLikelySecrets } from "./secrets.mjs";
import { createOpenAiClient } from "./openai.mjs";
import { buildAutocompleteState, formatAutocompletePanel, handleAutocompleteKeypress, handleControlJInput, handlePastedInput, handleVerticalInput, handleModelSelectorKeypress, handleModeKeypress } from "./editor.mjs";
import { modelSettings } from "./models.mjs";
import { toolsForMode, executeModeTool, assertModeCommand, createAgentModeState, modeInputPrompt } from "./agent-mode.mjs";
import { slashCommands } from "./commands.mjs";
import { workspaceTools } from "./tool-definitions.mjs";
import { COMMON_PROMPT, BUILD_PROMPT, PLAN_PROMPT, SUMMARY_INSTRUCTIONS, MCP_GUIDANCE, terminalGuidance, compactionMessages } from "./prompts.mjs";
import { chunkSummaryTranscript, compactionBudget, estimateMessageTokens, estimateTextTokens, findCompactionCutPoint, pruneToolHistory, textContent } from "./context.mjs";
import { safeTerminalText, terminalTextWidth, truncateStyledTerminalText, wrapMessage } from "./terminal-text.mjs";
import { createTerminalRendering } from "./markdown-terminal.mjs";
import { createTerminalFooter, readTerminalCursor } from "./terminal-footer.mjs";
import { investigateAndInitialize } from "./init-project.mjs";
import { prepareUserMessage as prepareAttachments } from "./attachments.mjs";
import { imageContentPart } from "./image.mjs";
import { createEvidenceLedger, createLoopGuard, executeRecordedTool, parseToolArguments, preflightCalls, toolEnvelope } from "./agent-runtime.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TOOL_ROUNDS = 32;
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h";
const BRACKETED_PASTE_DISABLE = "\u001b[?2004l";

const appDirectory = dirname(fileURLToPath(import.meta.url));
let applicationRoot;
let rootDirectory;
let workspaceName;
let endpoint;
let apiKey;
let model;
let contextWindow;
let evidenceLedger;
let inputModalities;
let compactionReserveTokens;
let compactionKeepRecentTokens;
let terminalMode;
let terminalCommandShell;
let skillsMode;
let mcpMode;
let skillDirectories = [];
let mcpConfigPath;
let workspaceAccess;
let openAiClient;
let useColor = stdout.isTTY && !Object.hasOwn(process.env, "NO_COLOR");
let compactedSummary = "";
let agentsContext = "";
let workspaceFiles = [];
let fileIndexDirty = true;
let fileIndexRefresh;
let availableSkills = [];
let skillPromptContext = "";
let mcpConnections = { toolDefinitions: [], toolLookup: new Map(), serverGuidance: [], warnings: [], close: async () => {} };
let lastPromptTokens;
let lastUsageMessageCount = 0;
let lastUsageSystemTokens = 0;
let interactiveTerminal;
let activeModelOperationController;
let activeModelRequestInFlight = false;
let activeProjectInitialization = false;
let activeSearch = false;
let persistentUiActive = false;
let persistentUiTerminal;
let persistentUiPrompt = "Build › ";
let persistentUiActivity = "Ready";
let persistentUiQueuedCount = 0;
let persistentUiAutocompleteState = null;
let persistentUiAutocompleteVisible = false;
let persistentFooter;
let persistentModelSelector;
let configuredModelDefaults;
let footerRenderScheduled = false;
const agentMode = createAgentModeState();

function activeTools() {
	return toolsForMode(tools, agentMode.effective);
}

function refreshCompactionBudget() {
	const budget = compactionBudget(contextWindow);
	compactionReserveTokens = budget.reserve;
	compactionKeepRecentTokens = budget.keepRecent;
}

function resetContextUsage() {
	lastPromptTokens = undefined;
	lastUsageMessageCount = 0;
	lastUsageSystemTokens = 0;
}

function refreshModeContext() {
	resetContextUsage();
	refreshSystemPrompt();
}

function writeTranscript(value) {
	if (persistentUiActive) persistentFooter.write(value);
	else stdout.write(value);
	if (persistentUiActive && !footerRenderScheduled) {
		footerRenderScheduled = true;
		setImmediate(() => {
			footerRenderScheduled = false;
			renderPersistentFooter();
		});
	}
}

const terminalOutput = {
	get columns() { return stdout.columns; },
	write: writeTranscript,
};

function setPersistentUiActivity(value) {
	persistentUiActivity = value;
	if (persistentUiActive) renderPersistentFooter();
}

function renderPersistentFooter() {
	if (!persistentUiActive || !persistentUiTerminal) return;
	const columns = Math.max(1, stdout.columns || 80);
	const terminal = persistentUiTerminal;
	const usage = contextUsage();
	const separator = uiText(" · ", "muted");
	const contextColor = usage.percent >= 90 ? "error" : usage.percent >= 75 ? "warning" : "cyan";
	const activityColor = persistentUiActivity === "Ready" ? "success" : persistentUiActivity === "Approval needed" ? "warning" : "cyan";
	const status = [
		...(agentMode.running && agentMode.running !== agentMode.selected ? [uiText(`Running: ${agentMode.running === "plan" ? "Plan" : "Build"}`, "cyan")] : []),
		uiText(model, "magenta", true),
		uiText(tokenCount(usage.used), "pale", true) + uiText(`/${tokenCount(contextWindow)} tokens`, "muted"),
		uiText(`${usage.percent.toFixed(1)}% ${usageMeter(usage.percent, 10)}`, contextColor),
		uiText(persistentUiActivity, activityColor, true),
		...(persistentUiQueuedCount > 0 ? [uiText(`${persistentUiQueuedCount} queued`, "warning")] : []),
	].join(separator);
	const hints = [["Tab", "mode", "warning"], ["/", "commands", "magenta"], ["@", "files", "cyan"], ["Ctrl+J", "new line", "success"], ["Esc", "stop", "warning"]]
		.map(([key, label, color]) => `${uiText(key, color, true)} ${uiText(label, "muted")}`).join("  ");
	const line = safeTerminalText(terminal.line ?? "");
	const cursor = Number.isInteger(terminal.cursor) ? Math.max(0, Math.min(terminal.cursor, line.length)) : line.length;
	const suggestions = persistentModelSelector
		? formatAutocompletePanel(persistentModelSelector, { columns, useColor, uiText })
		: persistentUiAutocompleteVisible && persistentUiAutocompleteState
		? formatAutocompletePanel(persistentUiAutocompleteState, { columns, useColor, uiText })
		: [];
	persistentFooter.render({
		status: truncateStyledTerminalText(status, columns),
		hints,
		prompt: persistentUiPrompt,
		line, cursor, suggestions,
	});
}

const tools = [...workspaceTools];

const messages = [{ role: "system", content: "" }];

async function initializeConfiguration() {
	const config = await loadConfiguration({ appDirectory });
	({
		applicationRoot,
		rootDirectory,
		workspaceName,
		endpoint,
		apiKey,
		model,
		contextWindow,
		inputModalities,
		terminalMode,
		terminalCommandShell,
		skillsMode,
		mcpMode,
	} = config);
	useColor = stdout.isTTY && !Object.hasOwn(process.env, "NO_COLOR");
	skillDirectories = [...new Set([
		join(applicationRoot, "skills"),
		join(applicationRoot, ".agents", "skills"),
		join(rootDirectory, "skills"),
		join(rootDirectory, ".agents", "skills"),
	])];
	mcpConfigPath = join(applicationRoot, ".minagent", "mcp.json");
	workspaceAccess = createWorkspaceAccess(rootDirectory, workspaceName);
	evidenceLedger = createEvidenceLedger(workspaceAccess);
	refreshCompactionBudget();
	openAiClient = createOpenAiClient({ endpoint, apiKey, model, tools });
	configuredModelDefaults = { contextWindow, inputModalities: [...inputModalities] };
	if (terminalMode !== "off") {
		tools.push({
			type: "function",
			function: {
				name: "run_terminal",
				description: "Run a shell command in the workspace.",
				parameters: {
					type: "object",
				properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		});
	}
}

function buildBaseSystemPrompt() {
	const sections = [[
		COMMON_PROMPT,
		`Workspace: ${workspaceName}.`,
		agentMode.effective === "plan" ? PLAN_PROMPT : BUILD_PROMPT,
	].join(" ")];
	if (agentMode.effective === "build" && terminalMode !== "off") {
		sections.push(terminalGuidance(terminalMode, describeTerminalEnvironment()));
	}
	if (agentMode.effective === "build" && skillPromptContext) {
		sections.push(`Skills: ${skillsMode}; ${skillsMode === "ask" ? "approve each load" : "no approval required"}.`);
		sections.push(skillPromptContext);
	}
	if (agentMode.effective === "build" && (mcpConnections.toolDefinitions.length > 0 || mcpConnections.serverGuidance.length > 0)) {
		sections.push(MCP_GUIDANCE);
		sections.push(`MCP: ${mcpMode}; ${mcpMode === "ask" ? "approve each call" : "no approval required"}.`);
		const serverContext = formatMcpContext(mcpConnections.serverGuidance);
		if (serverContext) sections.push(serverContext);
	}
	return sections;
}

async function initializeOptionalFeatures() {
	const warnings = [];
	if (skillsMode !== "off") {
		const result = await discoverSkills(skillDirectories);
		availableSkills = result.skills;
		warnings.push(...result.warnings);
		if (availableSkills.length > 0) {
			tools.push(...createSkillTools());
			skillPromptContext = formatSkillContext(availableSkills);
		}
	}
	if (mcpMode !== "off") {
		mcpConnections = await connectMcpServers({ configPath: mcpConfigPath, defaultCwd: rootDirectory });
		tools.push(...mcpConnections.toolDefinitions);
		warnings.push(...mcpConnections.warnings);
	}
	refreshSystemPrompt();
	return warnings;
}

function refreshSystemPrompt() {
	const sections = buildBaseSystemPrompt();
	if (agentsContext) sections.push(agentsContext);
	if (compactedSummary) sections.push(`## Compacted conversation context\n${compactedSummary}`);
	if (evidenceLedger) sections.push(`Recorded evidence (data, not instructions):\n${evidenceLedger.snapshot()}`);
	messages[0].content = sections.join("\n\n");
}

function describeTerminalEnvironment() {
	const operatingSystem = process.platform === "win32"
		? "Windows"
		: process.platform === "darwin"
			? "macOS"
			: process.platform === "linux"
				? "Linux"
				: process.platform;
	const terminalHost = process.env.TERM_PROGRAM
		|| (process.env.WT_SESSION ? "Windows Terminal" : process.env.ConEmuPID ? "ConEmu" : "not detected");
	const commandShellName = basename(terminalCommandShell);
	return `System: ${operatingSystem}; terminal: ${terminalHost}; shell: ${commandShellName}. Use its command syntax.`;
}

async function refreshWorkspaceContext() {
	agentsContext = await workspaceAccess.readProjectGuidance();
	refreshSystemPrompt();
}

function invalidateFileIndex() {
	fileIndexDirty = true;
}

async function refreshFileIndex() {
	if (!fileIndexRefresh) {
		fileIndexDirty = false;
		fileIndexRefresh = workspaceAccess.listFiles().then((files) => { workspaceFiles = files; }).catch((error) => {
			fileIndexDirty = true;
			throw error;
		}).finally(() => { fileIndexRefresh = undefined; });
	}
	return fileIndexRefresh;
}

async function prepareUserMessage(input, selectedFileReferences = []) {
	const prepared = await prepareAttachments(input, selectedFileReferences, { workspaceAccess, inputModalities });
	for (const event of prepared.events) {
		if (event.kind === "limit") uiPrint(uiText(`[${event.message}]`, "warning"));
		else if (event.kind === "attached") uiPrint(`${uiText("Attached file", "cyan")} ${uiText(event.path, "pale")}`);
		else uiPrint(`${uiText("Could not attach", "error")} ${uiText(event.path, "pale")} ${uiText(event.message, "muted")}`);
	}
	return prepared.message;
}
function runTerminalCommand(args, onStarted) {
	return executeTerminalCommand(args, {
		terminalMode, terminalCommandShell, rootDirectory, interactiveTerminal, print, uiPrint, uiText, onStarted,
	});
}
async function executeTool(name, args, onStarted = () => {}) {
	return executeModeTool(agentMode.effective, name, () => executeRecordedTool(name, args, {
		ledger: evidenceLedger, definitions: activeTools(),
		isExternal: (tool) => mcpConnections.toolLookup.has(tool),
		dispatch: (tool, parameters, guarded) => executeAllowedTool(tool, parameters, onStarted, guarded),
	}));
}

async function executeAllowedTool(name, args, onStarted, guarded = {}) {
		switch (name) {
		case "read_file":
			onStarted();
			return workspaceAccess.readFileDetailed(args, { imageEnabled: inputModalities.includes("image"), maxOutputBytes: Math.min(MAX_READ_OUTPUT_BYTES, Math.max(512, Math.floor(contextWindow * 0.75))) });
		case "list_directory":
			onStarted();
			return workspaceAccess.listDirectory(args);
		case "search_files":
			onStarted();
			activeSearch = true;
			try { return await workspaceAccess.searchFiles(args, { signal: activeModelOperationController?.signal }); }
			finally { activeSearch = false; }
		case "edit_file":
			invalidateFileIndex();
			onStarted();
			return workspaceAccess.editFile(args, guarded);
		case "write_file":
			invalidateFileIndex();
			onStarted();
			return workspaceAccess.writeFile(args, guarded);
		case "delete_file":
			invalidateFileIndex();
			onStarted();
			return workspaceAccess.deleteFile(args);
		case "delete_directory":
			invalidateFileIndex();
			onStarted();
			return workspaceAccess.deleteDirectory(args);
		case "run_terminal":
			return runTerminalCommand(args, () => { evidenceLedger.invalidate(); invalidateFileIndex(); onStarted(); });
		case "load_skill": {
			const allowed = await requestToolPermission({ mode: skillsMode, setting: "SKILLS_MODE", label: "Skills", subject: args.name, args, question: "Allow this skill load? [y/N] " }, { interactiveTerminal, print, uiPrint, uiText });
			if (!allowed) return "Permission denied by the user. The skill was not loaded.";
			onStarted();
			return executeSkillTool(name, args, availableSkills);
		}
		default:
			const mcpTool = mcpConnections.toolLookup.get(name);
			if (mcpTool) {
				const allowed = await requestToolPermission({ mode: mcpMode, setting: "MCP_MODE", label: "MCP", subject: `${mcpTool.serverName}/${mcpTool.remoteToolName}`, args, question: "Allow this MCP call? [y/N] " }, { interactiveTerminal, print, uiPrint, uiText });
				if (!allowed) return "MCP call denied by the user; it was not executed.";
				onStarted();
				evidenceLedger.invalidate();
				invalidateFileIndex();
				return executeMcpTool(name, args, mcpConnections.toolLookup, inputModalities.includes("image"));
			}
			throw new Error(`Tool is not available: ${name}`);
	}
}

function print(value) {
	writeTranscript(`${safeTerminalText(value)}\n`);
}

const UI_COLORS = {
	cyan: [31, 226, 220],
	magenta: [255, 48, 167],
	pale: [226, 239, 241],
	muted: [130, 153, 164],
	success: [112, 224, 154],
	warning: [255, 177, 109],
	error: [255, 108, 132],
	userBackground: [18, 49, 58],
	assistantBackground: [13, 21, 35],
};
function uiText(value, color = "pale", bold = false) {
	const safe = safeTerminalText(value);
	if (!useColor) return safe;
	const [red, green, blue] = UI_COLORS[color] ?? UI_COLORS.pale;
	return `\u001b[${bold ? "1;" : ""}38;2;${red};${green};${blue}m${safe}\u001b[0m`;
}

function uiPrint(value) {
	writeTranscript(`${value}${useColor ? "\u001b[0m" : ""}\n`);
}

function uiBubbleText(value, foreground, background) {
	const safe = safeTerminalText(value);
	if (!useColor) return safe;
	const [fr, fg, fb] = UI_COLORS[foreground] ?? UI_COLORS.pale;
	const [br, bg, bb] = UI_COLORS[background] ?? UI_COLORS.assistantBackground;
	return `\u001b[38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m${safe}\u001b[0m`;
}

function printUserBubble(text) {
	const columns = stdout.columns || 80;
	const maxContentWidth = Math.max(4, Math.min(66, columns - 8));
	const lines = wrapMessage(text, maxContentWidth);
	const contentWidth = Math.max(4, ...lines.map(terminalTextWidth));
	const outerWidth = contentWidth + 4;
	const indent = " ".repeat(Math.max(0, columns - outerWidth));
	const title = "╭─ YOU ";
	const titleFill = Math.max(0, outerWidth - terminalTextWidth(title) - 1);
	uiPrint(`${indent}${uiText(title, "magenta", true)}${uiText("─".repeat(titleFill) + "╮", "magenta")}`);
	for (const line of lines) {
		const padding = " ".repeat(Math.max(0, contentWidth - terminalTextWidth(line)));
		uiPrint(`${indent}${uiText("│", "magenta")}${uiBubbleText(` ${line}${padding} `, "pale", "userBackground")}${uiText("│", "magenta")}`);
	}
	uiPrint(`${indent}${uiText(`╰${"─".repeat(contentWidth + 2)}╯`, "magenta")}`);
}

function printError(error) {
	const text = safeTerminalText(error instanceof Error ? error.message : String(error));
	const errorWidth = Math.max(4, (stdout.columns || 80) - 4);
	print("");
	uiPrint(uiText("╭─ ERROR", "error", true));
	for (const line of wrapMessage(text, errorWidth)) uiPrint(`${uiText("│", "error")} ${uiText(line, "pale")}`);
	uiPrint(uiText(`╰${"─".repeat(Math.max(8, errorWidth))}`, "error"));
}

function tokenCount(value) {
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function usageMeter(percent, width = 20) {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function permissionModeLabel(mode) {
	if (mode === "auto") return "Auto";
	if (mode === "ask") return "Ask";
	return "Off";
}

function contextUsage() {
	const used = estimateCurrentContextTokens();
	const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
	return { used, percent };
}

function printStartupPanel() {
	const { used, percent } = contextUsage();
	print("");
	const rows = [
		["Model", model],
		["Context", `~${tokenCount(used)} / ${tokenCount(contextWindow)} tokens  ${percent.toFixed(1)}%  ${usageMeter(percent)}`],
		["Input", inputModalities.join(" · ")],
		["Terminal", permissionModeLabel(terminalMode)],
		["Workspace", workspaceName],
	];
	if (skillsMode !== "off" || mcpMode !== "off") {
		rows.push(["Extensions", `Skills ${permissionModeLabel(skillsMode)}${skillsMode !== "off" ? ` (${availableSkills.length} loaded)` : ""} · MCP ${permissionModeLabel(mcpMode)}${mcpMode !== "off" ? ` (${mcpConnections.toolLookup.size} tools)` : ""}`]);
	}
	const contents = ["MinAgent · SESSION", ...rows.map(([label, value]) => `${label.padEnd(10)} ${value}`)];
	const maxInnerWidth = Math.max(4, (stdout.columns || 80) - 4);
	const innerWidth = Math.min(maxInnerWidth, Math.max(4, ...contents.map(terminalTextWidth)));
	const edge = (left, right) => `${left}${"─".repeat(innerWidth + 2)}${right}`;
	const panelLine = (content, color = "pale") => {
		for (const line of wrapMessage(content, innerWidth)) {
			const padding = " ".repeat(Math.max(0, innerWidth - terminalTextWidth(line)));
			uiPrint(`${uiText("│", "cyan")} ${uiText(line, color)}${padding} ${uiText("│", "cyan")}`);
		}
	};
	uiPrint(uiText(edge("╭", "╮"), "cyan"));
	panelLine(contents[0], "magenta");
	for (const [label, value] of rows) {
		const content = `${label.padEnd(10)} ${value}`;
		if (terminalTextWidth(content) <= innerWidth) {
			const padding = " ".repeat(Math.max(0, innerWidth - terminalTextWidth(content)));
			uiPrint(`${uiText("│", "cyan")} ${uiText(label.padEnd(10), "muted")} ${uiText(value, "pale")}${padding} ${uiText("│", "cyan")}`);
		} else {
			panelLine(label.trimEnd(), "muted");
			panelLine(`  ${value}`, "pale");
		}
	}
	uiPrint(uiText(edge("╰", "╯"), "cyan"));
}

function printCommandMenu() {
	print("");
	uiPrint(uiText("╭─ COMMANDS", "magenta", true));
	for (const command of slashCommands) uiPrint(`  ${uiText(`/${command.name.padEnd(12)}`, "cyan", true)} ${uiText(command.description, "pale")}`);
	uiPrint(uiText("╰─ Enter to select · Esc to close", "muted"));
}

function showAutocompletePanel(state) {
	persistentUiAutocompleteState = state;
	persistentUiAutocompleteVisible = true;
	renderPersistentFooter();
}

function hideAutocompletePanel() {
	if (!persistentUiAutocompleteVisible) return;
	persistentUiAutocompleteVisible = false;
	persistentUiAutocompleteState = null;
	renderPersistentFooter();
}

function printToolResult(name, _args, result) {
	const failed = Boolean(result && typeof result === "object" && result.isError)
		|| (typeof result === "string" && (/^(?:Error:|Could not start the command:)/i.test(result)
			|| (name === "run_terminal" && /^Exit code: (?!0\b)/m.test(result))));
	if (result && typeof result === "object" && "toolText" in result) {
		const displayText = safeTerminalText(result.displayText ?? result.toolText).slice(0, 3000);
		uiPrint(`  ${uiText("└─", failed ? "error" : "cyan")} ${uiText(failed ? "Tool failed" : "Tool finished", failed ? "error" : "muted")}`);
		uiPrint(`     ${uiText(displayText, failed ? "error" : "pale")}`);
		if (!result.displayText && displayText.length < result.toolText.length) {
			uiPrint(uiText("     [Output truncated on screen; the full result was passed to the model.]", "muted"));
		}
		return;
	}
	const text = String(result);
	if (/^(?:Permission denied by the user|MCP call denied by the user)/i.test(text)) {
		uiPrint(`  ${uiText("└─", "warning")} ${uiText("Not executed", "warning", true)}`);
		uiPrint(`     ${uiText(text, "muted")}`);
		return;
	}
	if (text.startsWith("Error:")) {
		uiPrint(`  ${uiText("└─", "error")} ${uiText("Tool failed", "error", true)}`);
		uiPrint(`     ${uiText(text, "error")}`);
		return;
	}
	if (name === "run_terminal") {
		const shown = safeTerminalText(text).slice(0, 3000);
		uiPrint(`  ${uiText("└─", failed ? "error" : "cyan")} ${uiText(failed ? "Command failed" : "Command finished", failed ? "error" : "muted")}`);
		for (const line of shown.split(/\r?\n/)) uiPrint(`     ${uiText(line, failed ? "error" : "pale")}`);
		if (shown.length < text.length) uiPrint(uiText("     [Output truncated on screen; the full result is available to the model.]", "muted"));
		return;
	}
	uiPrint(`  ${uiText("└─", failed ? "error" : "cyan")} ${uiText(text, failed ? "error" : "pale")}`);
}

const { createStreamingOutput, createReasoningStreamingOutput } = createTerminalRendering({
	stdout: terminalOutput, getUseColor: () => useColor, UI_COLORS, uiText, uiPrint, print,
});
function estimateCurrentContextTokens() {
	const currentSystemTokens = estimateTextTokens(messages[0].content);
	if (Number.isFinite(lastPromptTokens) && lastUsageMessageCount <= messages.length) {
		const trailingTokens = messages.slice(lastUsageMessageCount).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		return Math.max(0, lastPromptTokens + currentSystemTokens - lastUsageSystemTokens + trailingTokens);
	}
	return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + estimateTextTokens(JSON.stringify(activeTools()));
}

async function runInterruptibleModelOperation(operation, onAbort) {
	const controller = new AbortController();
	activeModelOperationController = controller;
	try {
		return await operation(controller.signal);
	} catch (error) {
		if (!controller.signal.aborted) throw error;
		onAbort?.();
		return undefined;
	} finally {
		if (activeModelOperationController === controller) activeModelOperationController = undefined;
	}
}

async function callChatCompletions(requestMessages, options = {}) {
	activeModelRequestInFlight = true;
	setPersistentUiActivity(options.withTools ? "Model generating" : "Model summarizing");
	try {
		return await openAiClient.complete(requestMessages, {
			...options,
			maxTokens: options.maxTokens ? Math.min(options.maxTokens, compactionReserveTokens) : undefined,
			...(options.withTools ? { availableTools: options.availableTools
				? activeTools().filter((tool) => options.availableTools.some((allowed) => allowed.function?.name === tool.function?.name))
				: activeTools() } : {}),
			signal: options.signal ?? activeModelOperationController?.signal,
		});
	} finally {
		activeModelRequestInFlight = false;
	}
}

async function generateCompactionSummary(messagesToSummarize, previousSummary, customInstructions, displayLabel = "Compaction", signal) {
	const maxInputChars = Math.floor(contextWindow * 0.7);
	let rollingSummary = previousSummary;
	const summaryAllowance = Math.min(16_000, Math.floor(maxInputChars / 4));
	const transcriptAllowance = maxInputChars - SUMMARY_INSTRUCTIONS.length - summaryAllowance - String(customInstructions ?? "").length - 1500;
	if (transcriptAllowance < 512) throw new Error("The configured context window is too small for conversation compaction.");
	const chunks = chunkSummaryTranscript(messagesToSummarize, transcriptAllowance);
	if (chunks.length > 32) throw new Error("Conversation compaction would require more than 32 passes. Compact earlier or use a larger context window.");
	for (const [index, transcript] of (chunks.length ? chunks : ["(No messages)"]).entries()) {
		const boundedSummary = rollingSummary.length <= summaryAllowance ? rollingSummary
				: `${rollingSummary.slice(0, Math.floor(summaryAllowance * 0.7))}\n[Middle of prior summary omitted to fit context.]\n${rollingSummary.slice(-Math.floor(summaryAllowance * 0.25))}`;
		const maxTokens = Math.max(256, Math.min(Math.floor(0.8 * compactionReserveTokens), Math.floor(contextWindow / 8), Math.floor(summaryAllowance / 3)));
		const streamedOutput = createStreamingOutput(`${displayLabel} summary${chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : ""}`);
		let response;
		let streamStatus = "incomplete";
		try {
			response = await callChatCompletions(compactionMessages(transcript, boundedSummary, customInstructions), {
				maxTokens, signal, onTextDelta: (chunk) => streamedOutput.write(chunk),
			});
			if (signal?.aborted || response.message?.interrupted) throw signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
			streamStatus = "complete";
		} finally {
			streamedOutput.close(signal?.aborted ? "interrupted" : streamStatus);
		}
		rollingSummary = textContent(response.message.content).trim();
		if (!rollingSummary) throw new Error("The model returned an empty compaction summary.");
	}
	return rollingSummary;
}

function replaceConversation(recentMessages, summary) {
	compactedSummary = summary;
	messages.splice(1, messages.length - 1, ...recentMessages);
	resetContextUsage();
	refreshSystemPrompt();
}

async function startNewConversation() {
	messages.splice(1);
	evidenceLedger.clear();
	invalidateFileIndex();
	compactedSummary = "";
	resetContextUsage();
	await refreshWorkspaceContext();
	writeTranscript("\u001b[2J\u001b[H");
	printStartupPanel();
	uiPrint(uiText("◆ New conversation ready.", "cyan", true));
}

async function compactAutomaticallyIfNeeded(signal) {
	const threshold = contextWindow - compactionReserveTokens;
	if (estimateCurrentContextTokens() > threshold && pruneToolHistory(messages)) {
		resetContextUsage();
	}
	const fixedContextTokens = estimateTextTokens(messages[0].content) + estimateTextTokens(JSON.stringify(activeTools()));
	if (fixedContextTokens >= threshold) {
		const fixedContextParts = [];
		if (agentsContext) fixedContextParts.push("AGENTS.md");
		if (skillPromptContext) fixedContextParts.push("skills");
		if (mcpConnections.toolDefinitions.length > 0 || mcpConnections.serverGuidance.length > 0) fixedContextParts.push("MCP");
		fixedContextParts.push("tool schemas");
		const reduceOptions = [];
		if (agentsContext) reduceOptions.push("shorten AGENTS.md");
		if (terminalMode !== "off") reduceOptions.push("set TERMINAL_MODE=off");
		if (skillPromptContext) reduceOptions.push("set SKILLS_MODE=off");
		if (mcpConnections.toolDefinitions.length > 0) reduceOptions.push("set MCP_MODE=off");
		if (reduceOptions.length === 0) reduceOptions.push("increase OPENAI_CONTEXT_WINDOW");
		throw new Error(`Fixed context (${fixedContextParts.join(", ")}, about ${tokenCount(fixedContextTokens)} tokens) exceeds the automatic compaction budget of ${tokenCount(threshold)}. Try to ${reduceOptions.join(", or ")}.`);
	}
	const estimatedTokens = estimateCurrentContextTokens();
	if (estimatedTokens <= threshold) return;
	const conversationMessages = messages.slice(1);
	const cutIndex = findCompactionCutPoint(conversationMessages, compactionKeepRecentTokens);
	if (cutIndex <= 0) {
		throw new Error("The current request and recent conversation exceed the compaction threshold; send a shorter request or reduce the retained conversation.");
	}
	print("");
	uiPrint(uiText(`Automatic compaction · ~${tokenCount(estimatedTokens)} tokens`, "magenta", true));
	uiPrint(uiText("Summarizing earlier history.", "muted"));
	const summary = await generateCompactionSummary(conversationMessages.slice(0, cutIndex), compactedSummary, "", "Automatic compaction", signal);
	const recentMessages = conversationMessages.slice(cutIndex);
	replaceConversation(recentMessages, summary);
	const compactedTokens = estimateCurrentContextTokens();
	uiPrint(uiText(`Compaction complete · context ~${tokenCount(estimatedTokens)} → ~${tokenCount(compactedTokens)} tokens`, "cyan"));
}

async function compactManually(customInstructions, signal) {
	const conversationMessages = messages.slice(1);
	if (conversationMessages.length === 0) {
		uiPrint(uiText("There is no conversation to compact.", "muted"));
		return;
	}
	const cutIndex = findCompactionCutPoint(conversationMessages, compactionKeepRecentTokens);
	if (cutIndex <= 0) {
		uiPrint(uiText(`Nothing to compact; recent history is within ~${tokenCount(compactionKeepRecentTokens)} tokens. The remaining context is the prompt and tools; current usage is shown in the status bar.`, "muted"));
		return;
	}
	const messagesToSummarize = conversationMessages.slice(0, cutIndex);
	const recentMessages = conversationMessages.slice(cutIndex);
	const contextBefore = estimateCurrentContextTokens();
	const historyBefore = conversationMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	const historyAfter = recentMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	print("");
	uiPrint(uiText(`Manual compaction · keeping about ${tokenCount(historyAfter)} recent-history tokens.`, "magenta", true));
	const summary = await generateCompactionSummary(messagesToSummarize, compactedSummary, customInstructions, "Manual compaction", signal);
	replaceConversation(recentMessages, summary);
	const contextAfter = estimateCurrentContextTokens();
	const fixedAfter = estimateTextTokens(messages[0].content) + estimateTextTokens(JSON.stringify(activeTools()));
	uiPrint(uiText(`Compaction complete · history ~${tokenCount(historyBefore)} → ~${tokenCount(historyAfter)} · context ~${tokenCount(contextBefore)} → ~${tokenCount(contextAfter)} tokens`, "cyan"));
	uiPrint(uiText(`Prompt and tool schemas now account for ~${tokenCount(fixedAfter)} tokens; compaction only reduces conversation history.`, "muted"));
}

async function initializeProject(customInstructions, signal) {
	assertModeCommand(agentMode.effective, "init");
	activeProjectInitialization = true;
	try {
		return await runProjectInitialization(customInstructions, signal);
	} finally { activeProjectInitialization = false; }
}

async function runProjectInitialization(customInstructions, signal) {
	print("");
	const result = await investigateAndInitialize({
		workspace: workspaceAccess, workspaceName, tools, signal, focus: customInstructions,
		maxInputTokens: Math.floor(contextWindow * 0.6),
		onPhase: (phase) => {
			setPersistentUiActivity(`/init · ${phase}`);
			uiPrint(uiText(`/init · ${phase}…`, "magenta", true));
		},
		onToolStart: (name, args) => {
			const label = name === "read_file" ? "Read file" : name === "list_directory" ? "List directory" : name === "search_files" ? "Search files" : `Tool ${name}`;
			uiPrint(`${uiText("╭─", "magenta")} ${uiText(label.toUpperCase(), "pale", true)} ${uiText(args.path ?? ".", "muted")}`);
			uiPrint(uiText(name === "read_file" ? `│ Reading… from line ${args.offset ?? 1}${args.column ? `, column ${args.column}` : ""} (limit ${args.limit ?? MAX_READ_LINES})` : name === "search_files" ? `│ Searching… ${JSON.stringify(args.query)} · ${args.mode ?? "both"} · case ${args.case_sensitive ? "sensitive" : "insensitive"}` : "│ Listing…", "muted"));
		},
		onToolFinish: printToolResult,
		complete: async (researchMessages, options) => {
			if (options.withTools) return callChatCompletions(researchMessages, options);
			const streamedOutput = createStreamingOutput("Model · AGENTS.md generation");
			let status = "incomplete";
			try {
				const response = await callChatCompletions(researchMessages, { ...options, onTextDelta: (chunk) => streamedOutput.write(chunk) });
				status = response.message?.interrupted ? "interrupted" : "complete";
				return response;
			} finally { streamedOutput.close(signal?.aborted ? "interrupted" : status); }
		},
	});
	invalidateFileIndex();
	await refreshWorkspaceContext();
	uiPrint(uiText(`AGENTS.md ${result.action} · Evidence from ${result.inspectedFiles} inspected files.`, "cyan"));
	return result.action;
}

async function requestAssistantTurn(signal) {
	let emptyResponseRetries = 0;
	let repairAttempts = 0;
	let stalledCalls = 0;
	const loopGuard = createLoopGuard();
	for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
		if (signal?.aborted) return "";
		await refreshWorkspaceContext();
		if (signal?.aborted) return "";
		await compactAutomaticallyIfNeeded(signal);
		if (signal?.aborted) return "";
		const sentMessageCount = messages.length;
		const sentSystemTokens = estimateTextTokens(messages[0].content);
		const streamedOutput = createStreamingOutput(`Model · ${model}`);
		const reasoningOutput = createReasoningStreamingOutput();
		print("");
		uiPrint(uiText("Processing...", "muted"));
		let completion;
		let streamStatus = "incomplete";
		let observedToolCallDeltas = 0;
		try {
			completion = await callChatCompletions(messages, {
				withTools: true,
				signal,
				onTextDelta: (chunk) => streamedOutput.write(chunk),
				onReasoningDelta: (chunk) => reasoningOutput.write(chunk),
				onToolCallDelta: ({ index }) => {
					if (index + 1 > observedToolCallDeltas) {
						observedToolCallDeltas = index + 1;
						setPersistentUiActivity("Preparing tool call");
						uiPrint(`${uiText("Tool call detected", "magenta", true)} ${uiText(`(${observedToolCallDeltas}; waiting for complete request)`, "muted")}`);
					}
				},
			});
			streamStatus = "complete";
		} catch (error) {
			if (observedToolCallDeltas > 0) {
				const detail = safeTerminalText(error instanceof Error ? error.message : String(error));
				uiPrint(`${uiText("Tool call not executed", "error", true)} ${uiText(`The streamed request did not complete or validate: ${detail}`, "muted")}`);
			}
			if (error.code === "INVALID_TOOL_CALL" && !signal?.aborted && repairAttempts++ < 2) {
						messages.push({ role: "user", content: `No tools ran: ${redactLikelySecrets(error.message)} Return a complete valid call using advertised JSON arguments.` });
				uiPrint(uiText("Requesting a corrected tool call.", "warning"));
				continue;
			}
			throw error;
		} finally {
			streamedOutput.close(signal?.aborted ? "interrupted" : streamStatus);
			reasoningOutput.close();
		}
		const { payload, message } = completion;
		if (signal?.aborted || message.interrupted) {
			const partialText = textContent(message.content).trim();
			if (partialText) messages.push({ role: "assistant", content: message.content });
			if (observedToolCallDeltas > 0) uiPrint(uiText("Tool call not executed; response was stopped before validation.", "warning"));
			uiPrint(uiText("Response stopped. You can send a new message.", "warning"));
			return partialText;
		}
		const promptTokens = Number(payload?.usage?.prompt_tokens);
		lastPromptTokens = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : undefined;
		lastUsageMessageCount = lastPromptTokens ? sentMessageCount : 0;
		lastUsageSystemTokens = lastPromptTokens ? sentSystemTokens : 0;
		const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
		let batchError;
		try { preflightCalls(calls, activeTools(), (name) => mcpConnections.toolLookup.has(name)); }
		catch (error) { batchError = error; }
		if (batchError && repairAttempts++ >= 2) throw new Error(`Tool request correction limit reached: ${batchError.message}`);
		if (calls.length === 0) {
			if (observedToolCallDeltas > 0) uiPrint(uiText("Tool call not executed; the completed response contained no valid tool request.", "error"));
			const finalText = textContent(message.content ?? message.refusal);
			if (!finalText.trim()) {
				emptyResponseRetries += 1;
				if (emptyResponseRetries < 2) {
					uiPrint(uiText("The endpoint returned an empty response; retrying once.", "warning"));
					continue;
				}
				throw new Error("The endpoint returned an empty assistant response twice. Check that the selected model supports Chat Completions and tool-call follow-up messages.");
			}
			if (!streamedOutput.hasOutput) {
				const fallbackOutput = createStreamingOutput(`Model · ${model}`);
				fallbackOutput.write(finalText);
				fallbackOutput.close();
			}
			messages.push({ role: "assistant", content: message.content ?? finalText });
			return finalText;
		}

		emptyResponseRetries = 0;
		if (signal?.aborted) return "";
		messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
		const pendingImages = [];
		let deniedToolCalls = 0;
		for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
			const call = calls[callIndex];
			const name = call?.function?.name;
			const callId = call?.id || `call-${round}-${messages.length}`;
			if (signal?.aborted) {
				for (const skippedCall of calls.slice(callIndex)) {
					messages.push({ role: "tool", tool_call_id: skippedCall.id, content: "Tool call canceled before execution because the response was stopped." });
				}
				break;
			}
			let result;
			let args = {};
			let toolError;
			let loopId;
			try {
				args = parseToolArguments(call?.function?.arguments ?? "{}");
				if (batchError) throw batchError;
				loopId = loopGuard.check(name, args);
				const mcpTool = mcpConnections.toolLookup.get(name);
				const subject = typeof args.path === "string" ? args.path : name === "list_directory" ? "." : typeof args.command === "string" ? args.command : "";
				const fileToolLabels = {
					search_files: "Search files",
					list_directory: "List directory",
					read_file: "Read file",
					edit_file: "Edit file",
					write_file: "Write file",
					delete_file: "Delete file",
					delete_directory: "Delete directory",
				};
				const label = mcpTool
					? `MCP ${mcpTool.serverName}/${mcpTool.remoteToolName}`
					: name === "run_terminal" ? "Terminal" : fileToolLabels[name] ?? `Tool ${name}`;
				print("");
				uiPrint(`${uiText("╭─", "magenta")} ${uiText(label.toUpperCase(), "pale", true)}`);
				if (subject) uiPrint(`${uiText("│", "magenta")} ${uiText(subject, "muted")}`);
				else if (mcpTool && Object.keys(args).length > 0) uiPrint(`${uiText("│", "magenta")} ${uiText(approvalPreview(args), "muted")}`);
				result = await executeTool(name, args, () => {
					setPersistentUiActivity(`Running ${label}`);
					if (name === "search_files") {
						uiPrint(`${uiText("│", "magenta")} ${uiText(`Searching… ${JSON.stringify(args.query)} · ${args.mode ?? "both"} · ${args.path ?? "."} · case ${args.case_sensitive ? "sensitive" : "insensitive"}`, "muted")}`);
					} else if (name === "read_file") {
						const offset = args.offset ?? 1;
						const column = args.column ?? 1;
						const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
						uiPrint(`${uiText("│", "magenta")} ${uiText(`Reading… lines ${offset}–${offset + limit - 1}${column > 1 ? `, column ${column}` : ""} (limit ${limit})`, "muted")}`);
					} else {
						uiPrint(`${uiText("│", "magenta")} ${uiText("Running…", "muted")}`);
					}
				});
			} catch (error) {
				toolError = error;
				const detail = error instanceof Error ? error.message : String(error);
				const uncertainChange = error?.mayHaveChanged ? " The file may have changed despite this error; inspect it before relying on its contents." : "";
				result = `Error: ${detail}${uncertainChange}`;
			}
			printToolResult(name, args, result);
			const envelope = toolEnvelope(name, args, result, toolError);
			if (["REPEATED_FAILURE", "REPEATED_RESULT"].includes(toolError?.code)) stalledCalls += 1;
			else if (["success", "incomplete"].includes(envelope.metadata.status)) stalledCalls = 0;
			evidenceLedger.recordOutcome(envelope.metadata);
			if (loopId) loopGuard.record(loopId, envelope.metadata, envelope.content);
			setPersistentUiActivity("Model working");
			if (typeof result === "string" && /^(?:Permission denied by the user|MCP call denied by the user)/i.test(result)) deniedToolCalls += 1;
			messages.push({ role: "tool", tool_call_id: callId, content: envelope.content });
			if (result?.image) pendingImages.push(result.image);
			if (Array.isArray(result?.images)) pendingImages.push(...result.images);
		}
		if (signal?.aborted) {
			uiPrint(uiText("Response stopped. You can send a new message.", "warning"));
			return "";
		}
		if (stalledCalls >= 2) throw new Error("Stopped repeated tool calls without new evidence. Send a clarification or choose another approach.");
		if (deniedToolCalls === calls.length) {
			uiPrint(uiText("All requested tool calls were denied. No tool was executed.", "warning"));
			return "";
		}
		if (pendingImages.length > 0) {
			messages.push({
				role: "user",
				content: [
					{ type: "text", text: "Attached image(s) from tool result:" },
					...pendingImages.map(imageContentPart),
				],
			});
		}
	}
	throw new Error(`Stopped after ${MAX_TOOL_ROUNDS} consecutive tool rounds.`);
}

function assertInteractiveTerminal() {
	if (!stdin.isTTY || !stdout.isTTY) {
		throw new Error("MinAgent requires an interactive terminal.");
	}
}

async function main() {
	await initializeConfiguration();
	assertInteractiveTerminal();
	try {
		const featureWarnings = await initializeOptionalFeatures();
		await refreshWorkspaceContext();
		printStartupPanel();
		for (const warning of featureWarnings) uiPrint(`${uiText("Feature setup", "warning", true)} ${uiText(warning, "muted")}`);
		const initialCursor = await readTerminalCursor(stdin, stdout);
		persistentFooter = createTerminalFooter(stdout, initialCursor ?? { row: Math.min(stdout.rows || 24, 9 + featureWarnings.length), column: 0 });
		const readlineOutput = new Writable({
			write(_chunk, _encoding, callback) {
				renderPersistentFooter();
				callback();
			},
		});
		Object.defineProperties(readlineOutput, {
			isTTY: { value: true },
			columns: { get: () => stdout.columns || 80 },
			rows: { get: () => stdout.rows || 24 },
		});
		const terminal = createInterface({ input: stdin, output: readlineOutput, terminal: true });
		const terminalCloseController = new AbortController();
		terminal.once("close", () => terminalCloseController.abort());
		let pendingApprovalResolver;
		let pendingModelSelectionResolver;
		const closeModelSelector = (selected = null) => {
			persistentModelSelector = undefined;
			const resolve = pendingModelSelectionResolver;
			pendingModelSelectionResolver = undefined;
			resolve?.(selected);
			renderPersistentFooter();
		};
		const selectModel = (catalog) => new Promise((resolve) => {
			pendingModelSelectionResolver = resolve;
			persistentUiAutocompleteVisible = false;
			persistentUiAutocompleteState = null;
			persistentModelSelector = {
				kind: "model", totalMatches: catalog.length,
				candidates: catalog.map((entry) => ({ value: entry.id, label: `${entry.id}${entry.id === model ? " (current)" : ""}` })),
				selectedIndex: Math.max(0, catalog.findIndex((entry) => entry.id === model)),
			};
			setPersistentUiActivity("Select model");
		});
		interactiveTerminal = {
			question: (question) => new Promise((resolve) => {
				if (pendingApprovalResolver) throw new Error("An approval prompt is already active.");
				pendingApprovalResolver = resolve;
				persistentUiPrompt = question;
				setPersistentUiActivity("Approval needed");
				renderPersistentFooter();
			}),
		};
		persistentUiTerminal = terminal;
		persistentUiActive = true;
		const verticalInputState = {};
		const onTerminalResize = () => {
			verticalInputState.goalColumn = undefined;
			readlineOutput.emit("resize");
			renderPersistentFooter();
		};
		stdout.on("resize", onTerminalResize);
		renderPersistentFooter();
		const pasteState = { active: false, bulkInputChunk: false, skipNextLineFeed: false, lineFeedTimer: undefined };
		let bracketedPasteEnabled = true;
		const disableBracketedPaste = () => {
			if (!bracketedPasteEnabled) return;
			bracketedPasteEnabled = false;
			stdout.write(BRACKETED_PASTE_DISABLE);
		};
		stdout.write(BRACKETED_PASTE_ENABLE);
		process.once("exit", disableBracketedPaste);
		let dismissedAutocompleteSignature = "";
		let skipAutocompleteRefresh = false;
		const selectedFileReferences = new Set();
		let promptVisibleLength;
		let promptText;
		const updateModeInputPrompt = () => {
			const prompt = modeInputPrompt(agentMode.selected, useColor);
			promptText = prompt.text;
			promptVisibleLength = prompt.width;
			persistentUiPrompt = promptText;
			terminal.setPrompt(promptText);
			verticalInputState.goalColumn = undefined;
		};
		updateModeInputPrompt();
		const autocompleteSignature = (line, cursor) => `${line}\u0000${cursor}`;
		renderPersistentFooter();
		const updateAutocomplete = () => {
			if (terminal.closed || persistentModelSelector || pendingApprovalResolver) return;
			const line = typeof terminal.line === "string" ? terminal.line : "";
			const cursor = Number.isInteger(terminal.cursor) ? terminal.cursor : line.length;
			const signature = autocompleteSignature(line, cursor);
			if (dismissedAutocompleteSignature === signature) {
				hideAutocompletePanel();
				return;
			}
			const prefix = line.slice(0, cursor);
			const atIndex = prefix.lastIndexOf("@");
			if (atIndex >= 0 && (atIndex === 0 || /\s/.test(prefix[atIndex - 1])) && (fileIndexDirty || fileIndexRefresh)) {
				hideAutocompletePanel();
				refreshFileIndex().then(updateAutocomplete).catch(printError);
				return;
			}
			const next = buildAutocompleteState(line, cursor, workspaceFiles, slashCommands);
			if (!next || line.includes("\n") || terminalTextWidth(line) + promptVisibleLength >= (stdout.columns || 80)) {
				hideAutocompletePanel();
				return;
			}
			if (persistentUiAutocompleteState
				&& persistentUiAutocompleteState.kind === next.kind
				&& persistentUiAutocompleteState.start === next.start
				&& persistentUiAutocompleteState.query === next.query) {
				next.selectedIndex = Math.min(persistentUiAutocompleteState.selectedIndex, next.candidates.length - 1);
			}
			showAutocompletePanel(next);
		};
		const keypressCapture = (character, key) => {
			if (persistentModelSelector) {
				// A pasted Enter must not choose a model accidentally.
				if (handlePastedInput(key, character, terminal, pasteState)) return;
				const action = handleModelSelectorKeypress(persistentModelSelector, key);
				if (action) {
					skipAutocompleteRefresh = true;
					if (action.kind === "select") closeModelSelector(action.model);
					else if (action.kind === "cancel") closeModelSelector();
					else renderPersistentFooter();
					return;
				}
			}
			if (!["up", "down"].includes(key?.name) || key?.ctrl || key?.meta || key?.shift) verticalInputState.goalColumn = undefined;
			if (key?.name === "escape" && activeModelOperationController) {
				key.name = "unbound";
				key.ctrl = false;
				key.meta = false;
				if ((activeModelRequestInFlight || activeProjectInitialization || activeSearch) && !activeModelOperationController.signal.aborted) {
					activeModelOperationController.abort();
				}
				return;
			}
			// Keep pasted line breaks inside this prompt instead of letting readline submit each line.
			if (handlePastedInput(key, character, terminal, pasteState)) {
				if ((pasteState.active || pasteState.bulkInputChunk) && persistentUiAutocompleteVisible) {
					hideAutocompletePanel();
				}
				return;
			}
			if (!pendingApprovalResolver && handleModeKeypress(key)) {
				agentMode.toggle();
				updateModeInputPrompt();
				if (!agentMode.running) refreshModeContext();
				renderPersistentFooter();
				return;
			}
			// Ctrl+J sends LF; insert it in the readline buffer instead of submitting the turn.
			if (handleControlJInput(key, character, terminal)) return;
			const action = handleAutocompleteKeypress(persistentUiAutocompleteState, key, terminal);
			if (action?.kind === "move") {
				verticalInputState.goalColumn = undefined;
				skipAutocompleteRefresh = true;
				showAutocompletePanel(persistentUiAutocompleteState);
				return;
			}
			if (action?.kind === "complete") {
				skipAutocompleteRefresh = true;
				if (action.selectedFile) selectedFileReferences.add(action.selectedFile);
				dismissedAutocompleteSignature = "";
				hideAutocompletePanel();
				return;
			}
			if (handleVerticalInput(key, terminal, verticalInputState, { prompt: persistentUiPrompt, columns: stdout.columns || 80 })) return;
			if (!persistentUiAutocompleteState
				|| persistentUiAutocompleteState.line !== terminal.line
				|| persistentUiAutocompleteState.cursor !== terminal.cursor) return;
			if (key?.name === "escape") {
				key.name = "unbound";
				dismissedAutocompleteSignature = autocompleteSignature(terminal.line, terminal.cursor);
				persistentUiAutocompleteState = null;
				skipAutocompleteRefresh = true;
				setImmediate(() => {
					hideAutocompletePanel();
				});
			}
		};
		const onKeypress = (character, key) => {
			if (pasteState.active || pasteState.bulkInputChunk) return;
			if (skipAutocompleteRefresh) {
				skipAutocompleteRefresh = false;
				return;
			}
			if ((key?.name === "return" || key?.name === "enter") && character !== "\n") return;
			dismissedAutocompleteSignature = "";
			setImmediate(updateAutocomplete);
		};
		stdin.prependListener("keypress", keypressCapture);
		stdin.on("keypress", onKeypress);
		terminal.on("SIGINT", () => {
			closeModelSelector();
			if (pendingApprovalResolver) {
				const resolveApproval = pendingApprovalResolver;
				pendingApprovalResolver = undefined;
				resolveApproval("n");
			}
			activeModelOperationController?.abort();
			terminal.close();
		});
		let activePromptPromise;
		const queuedPrompts = [];
		const executePrompt = async ({ input, fileReferences }) => {
			const prompt = input.trim();
			if (!prompt) return;
			invalidateFileIndex();
			if (prompt === "/exit") {
				queuedPrompts.length = 0;
				persistentUiQueuedCount = 0;
				terminal.close();
				return;
			}
			if (prompt === "/new") {
				await startNewConversation();
				return;
			}
			if (prompt === "/") {
				printCommandMenu();
				return;
			}
			const compactCommand = input.match(/^\/compact(?:\s+([\s\S]*))?$/i);
			const initCommand = input.match(/^\/init(?:\s+([\s\S]*))?$/i);
			const modelCommand = prompt.match(/^\/model(?:\s+([^\r\n]+))?$/i);
			try {
				if (modelCommand) {
					setPersistentUiActivity("Loading models");
					uiPrint(uiText("/model · Loading the API model catalog…", "magenta", true));
					const catalog = await runInterruptibleModelOperation(async (signal) => {
						activeModelRequestInFlight = true;
						try { return await openAiClient.listModels({ signal }); }
						finally { activeModelRequestInFlight = false; }
					}, () => uiPrint(uiText("Model listing canceled.", "warning")));
					if (!catalog || terminal.closed) return;
					const selected = modelCommand[1]?.trim() || await selectModel(catalog);
					if (!selected || terminal.closed) return;
					const entry = catalog.find((item) => item.id === selected);
					if (!entry) throw new Error(`Model '${selected}' is not in the API catalog. Use /model to choose an available identifier.`);
					if (selected === model) {
						uiPrint(uiText(`Model ${model} is already selected.`, "muted"));
						return;
					}
					const settings = modelSettings(entry, configuredModelDefaults, messages);
					const nextClient = createOpenAiClient({ endpoint, apiKey, model: selected, tools });
					model = selected;
					openAiClient = nextClient;
					contextWindow = settings.contextWindow;
					inputModalities = settings.inputModalities;
					refreshCompactionBudget();
					resetContextUsage();
					uiPrint(uiText(`Model switched to ${model} for this session.`, "success", true));
					if (!settings.knownContext) uiPrint(uiText(`Context size not supplied by the API; using configured ${tokenCount(contextWindow)} tokens.`, "muted"));
					if (!settings.knownInput) uiPrint(uiText(`Input capabilities not supplied by the API; using configured ${inputModalities.join(", ")}.`, "muted"));
					renderPersistentFooter();
					return;
				}
				if (compactCommand) {
					printUserBubble(input);
					await refreshWorkspaceContext();
					setPersistentUiActivity("Compacting context");
					await runInterruptibleModelOperation(
						(signal) => compactManually(compactCommand[1]?.trim() || "", signal),
						() => uiPrint(uiText("Compaction canceled.", "warning")),
					);
					return;
				}
				if (initCommand) {
					assertModeCommand(agentMode.effective, "init");
					printUserBubble(input);
					await refreshWorkspaceContext();
					setPersistentUiActivity("Preparing AGENTS.md");
					const action = await runInterruptibleModelOperation(
						(signal) => initializeProject(initCommand[1]?.trim() || "", signal),
						() => uiPrint(uiText("AGENTS.md generation canceled.", "warning")),
					);
					if (!action) return;
					messages.push({ role: "user", content: input });
					messages.push({ role: "assistant", content: `AGENTS.md ${action} at the workspace root.` });
					return;
				}
				printUserBubble(input);
				const message = await prepareUserMessage(input, fileReferences);
				evidenceLedger.begin(input);
				messages.push(message);
				setPersistentUiActivity("Model working");
				await runInterruptibleModelOperation(
					(signal) => requestAssistantTurn(signal),
					() => uiPrint(uiText("Response stopped. You can send a new message.", "warning")),
				);
			} catch (error) {
				printError(error);
			}
		};
		const startNextPrompt = () => {
			if (activePromptPromise || queuedPrompts.length === 0) return;
			const next = queuedPrompts.shift();
			const previousMode = agentMode.effective;
			agentMode.begin(next.mode);
			if (agentMode.effective !== previousMode) refreshModeContext();
			else refreshSystemPrompt();
			persistentUiQueuedCount = queuedPrompts.length;
			setPersistentUiActivity(queuedPrompts.length ? `Working · ${queuedPrompts.length} queued` : "Working");
			activePromptPromise = Promise.resolve().then(() => executePrompt(next)).catch(printError).finally(() => {
				activePromptPromise = undefined;
				const completedMode = agentMode.effective;
				agentMode.end();
				if (agentMode.effective !== completedMode) refreshModeContext();
				else refreshSystemPrompt();
				if (queuedPrompts.length > 0) startNextPrompt();
				else setPersistentUiActivity("Ready");
			});
		};
		try {
			for (;;) {
				let input;
				try {
					input = await terminal.question(promptText, { signal: terminalCloseController.signal });
				} catch {
					if (activePromptPromise) await activePromptPromise;
					break;
				}
				if (pendingApprovalResolver) {
					const resolveApproval = pendingApprovalResolver;
					pendingApprovalResolver = undefined;
					persistentUiPrompt = promptText;
					setPersistentUiActivity("Model working");
					resolveApproval(input);
					renderPersistentFooter();
					continue;
				}
				if (persistentUiAutocompleteVisible) {
					hideAutocompletePanel();
				}
				persistentUiAutocompleteState = null;
				dismissedAutocompleteSignature = "";
				const prompt = input.trim();
				if (!prompt) {
					selectedFileReferences.clear();
					continue;
				}
				const fileReferences = [...selectedFileReferences];
				selectedFileReferences.clear();
				queuedPrompts.push({ input, fileReferences, mode: agentMode.capture() });
				persistentUiQueuedCount = queuedPrompts.length;
				if (activePromptPromise) {
					setPersistentUiActivity(`Working · ${queuedPrompts.length} queued`);
					uiPrint(uiText(`Queued message · ${queuedPrompts.length} waiting`, "muted"));
				} else {
					startNextPrompt();
				}
			}
		} finally {
			closeModelSelector();
			persistentUiActive = false;
			persistentUiTerminal = undefined;
			interactiveTerminal = undefined;
			stdout.write("\u001b[r\u001b[0J\u001b[?25h");
			stdout.removeListener("resize", onTerminalResize);
			disableBracketedPaste();
			process.removeListener("exit", disableBracketedPaste);
			if (pasteState.lineFeedTimer) clearTimeout(pasteState.lineFeedTimer);
			stdin.removeListener("keypress", keypressCapture);
			stdin.removeListener("keypress", onKeypress);
			terminal.close();
			stdout.write(`\u001b[${stdout.rows || 24};1H\r\n`);
		}
	} finally {
		await mcpConnections.close();
	}
}

try {
	await main();
} catch (error) {
	printError(error);
	process.exitCode = 1;
}
