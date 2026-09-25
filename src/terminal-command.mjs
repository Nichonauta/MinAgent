import { spawn } from "node:child_process";
import { terminateProcessTree } from "./processes.mjs";
import { safeTerminalText } from "./terminal-text.mjs";

export async function runTerminalCommand(args, {
	terminalMode, terminalCommandShell, rootDirectory, interactiveTerminal, print, uiPrint, uiText,
}) {
	if (terminalMode === "off") throw new Error("Terminal access is disabled by TERMINAL_MODE.");
	if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command must be a non-empty string.");
	if (args.command.length > 20_000) throw new Error("command is longer than the 20,000 character limit.");
	if (terminalMode === "ask") {
		if (!interactiveTerminal) throw new Error("Cannot request permission outside the interactive terminal.");
		print("");
		uiPrint(uiText("Terminal permission requested", "warning", true));
		uiPrint(uiText(JSON.stringify(args.command), "pale"));
		const answer = await interactiveTerminal.question("Allow this command? [y/N] ");
		if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
			return "Permission denied by the user. The command was not executed.";
		}
	}

	return new Promise((resolveResult) => {
		const chunks = [];
		const outputLimit = 64 * 1024;
		let bytesStored = 0;
		let truncated = false;
		let timedOut = false;
		const child = spawn(args.command, {
			cwd: rootDirectory,
			shell: terminalCommandShell,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			terminateProcessTree(child);
		};
		const append = (chunk) => {
			const remaining = outputLimit - bytesStored;
			if (remaining <= 0) {
				truncated = true;
				stop();
				return;
			}
			const kept = chunk.subarray(0, remaining);
			chunks.push(kept);
			bytesStored += kept.length;
			if (kept.length < chunk.length) {
				truncated = true;
				stop();
			}
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, 120_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolveResult(`Could not start the command: ${error.message}`);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString("utf8");
			const notes = [];
			if (timedOut) notes.push("Command stopped after 120 seconds.");
			if (truncated) notes.push("Output truncated at 64 KiB; command was stopped.");
			resolveResult(safeTerminalText([
				`Exit code: ${code ?? `terminated (${signal ?? "unknown signal"})`}`,
				output,
				...notes,
			].filter(Boolean).join("\n")));
		});
	});
}
