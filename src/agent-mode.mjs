const PLAN_TOOLS = new Set(["read_file", "list_directory", "search_files"]);

export function modeInputPrompt(mode, useColor = false) {
	const label = mode === "plan" ? "Plan" : "Build";
	const plain = `${label} › `;
	const color = mode === "plan" ? "255;197;92" : "112;224;154";
	return {
		text: useColor ? `\u0001\u001b[1;38;2;${color}m\u0002${label} \u0001\u001b[38;2;31;226;220m\u0002›\u0001\u001b[0m\u0002 ` : plain,
		width: plain.length,
	};
}

export function toolsForMode(tools, mode) {
	return mode === "plan" ? tools.filter((tool) => PLAN_TOOLS.has(tool.function?.name)) : tools;
}

export function executeModeTool(mode, name, operation) {
	if (mode === "plan" && !PLAN_TOOLS.has(name)) throw new Error(`Tool '${name}' is unavailable in Plan mode. Switch to Build.`);
	return operation();
}

export function assertModeCommand(mode, command) {
	if (mode === "plan" && command === "init") throw new Error("/init writes AGENTS.md; switch to Build first.");
}

export function createAgentModeState() {
	let selected = "build";
	let running = null;
	return {
		get selected() { return selected; },
		get running() { return running; },
		get effective() { return running ?? selected; },
		toggle() { selected = selected === "build" ? "plan" : "build"; },
		capture() { return selected; },
		begin(mode) { running = mode; },
		end() { running = null; },
	};
}
