import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";

export function loadEnvFile(filePath, target = process.env) {
	let contents;
	try {
		contents = readFileSync(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) throw new Error(`Invalid .env entry on line ${index + 1}. Expected NAME=value.`);
		if (target[match[1]] !== undefined) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		target[match[1]] = value;
	}
}

export function parsePositiveInteger(value, name, fallback) {
	if (value === undefined || value.trim() === "") return fallback;
	if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer.`);
	const parsed = Number(value.trim());
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
	return parsed;
}

export function parseDirectoryEntryLimit(value) {
	if (value === undefined || value.trim() === "") return -1;
	const normalized = value.trim();
	if (!/^-?\d+$/.test(normalized)) throw new Error("WORKSPACE_LIST_LIMIT must be -1 or a non-negative integer.");
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed) || parsed < -1) throw new Error("WORKSPACE_LIST_LIMIT must be -1 or a non-negative integer.");
	return parsed;
}

export function parseTerminalMode(value) {
	const normalized = value.trim();
	if (normalized === "auto") return "auto";
	if (normalized === "ask") return "ask";
	if (normalized === "off") return "off";
	throw new Error("TERMINAL_MODE must be lowercase: auto, ask, or off.");
}

export function parseBooleanSetting(value, name, fallback) {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "on") return true;
	if (normalized === "off") return false;
	throw new Error(`${name} must be on or off.`);
}

export function parseInputModalities(value) {
	const items = (value === undefined || value.trim() === "" ? "text,image" : value)
		.split(/[\s,]+/)
		.map((item) => item.toLowerCase())
		.filter(Boolean);
	const unique = [...new Set(items)];
	if (!unique.includes("text") || unique.some((item) => !["text", "image"].includes(item))) {
		throw new Error("OPENAI_INPUT must include text and only supports the values text,image.");
	}
	return unique;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
	const major = Number(String(version).split(".")[0]);
	if (!Number.isInteger(major) || major < 22) throw new Error(`MinAgent requires Node.js 22 or later. Installed version: ${version}.`);
}

export function makeEndpoint(baseUrl) {
	let parsed;
	try {
		parsed = new URL(baseUrl.trim());
	} catch {
		throw new Error("OPENAI_BASE_URL must be a valid HTTP or HTTPS URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OPENAI_BASE_URL must use HTTP or HTTPS.");
	}
	if (!parsed.pathname.replace(/\/$/, "").endsWith("/chat/completions")) {
		parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/chat/completions`;
	}
	return parsed.toString();
}

export async function loadConfiguration({ appDirectory, cwd = process.cwd(), env = process.env } = {}) {
	assertSupportedNodeVersion();
	if (!appDirectory) throw new Error("The MinAgent application directory could not be determined.");
	const applicationRoot = resolve(appDirectory, "..");
	loadEnvFile(join(applicationRoot, ".env"), env);
	const rootDirectory = await realpath(cwd);
	const model = env.OPENAI_MODEL?.trim();
	if (!model) throw new Error("Set OPENAI_MODEL to the model identifier available on your endpoint.");
	const contextWindow = parsePositiveInteger(env.OPENAI_CONTEXT_WINDOW, "OPENAI_CONTEXT_WINDOW", 262144);
	const inputModalities = parseInputModalities(env.OPENAI_INPUT);
	const terminalMode = parseTerminalMode(env.TERMINAL_MODE || "ask");
	return {
		appDirectory,
		applicationRoot,
		rootDirectory,
		workspaceName: basename(rootDirectory) || "workspace",
		endpoint: makeEndpoint(env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
		apiKey: env.OPENAI_API_KEY?.trim(),
		model,
		contextWindow,
		inputModalities,
		compactionReserveTokens: Math.min(16384, Math.floor(contextWindow / 8)),
		compactionKeepRecentTokens: Math.min(20000, Math.floor(contextWindow / 8)),
		workspaceListLimit: parseDirectoryEntryLimit(env.WORKSPACE_LIST_LIMIT),
		terminalMode,
		terminalCommandShell: process.platform === "win32" ? (env.ComSpec?.trim() || "cmd.exe") : "/bin/sh",
		skillsEnabled: parseBooleanSetting(env.SKILLS_ENABLED, "SKILLS_ENABLED", false),
		showReasoning: parseBooleanSetting(env.OPENAI_SHOW_REASONING, "OPENAI_SHOW_REASONING", false),
		mcpEnabled: parseBooleanSetting(env.MCP_ENABLED, "MCP_ENABLED", false),
	};
}
