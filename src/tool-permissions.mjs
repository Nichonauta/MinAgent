import { approvalPreview } from "./secrets.mjs";

export async function requestToolPermission({ mode, setting, label, subject = "", args, preview, question }, {
	interactiveTerminal, print, uiPrint, uiText,
}) {
	if (mode === "off") throw new Error(`${label} access is disabled by ${setting}.`);
	if (mode === "auto") return true;
	if (mode !== "ask") throw new Error(`${setting} must be auto, ask, or off.`);
	if (!interactiveTerminal) throw new Error("Cannot request permission outside the interactive terminal.");
	const shown = args === undefined ? preview : approvalPreview(args, 8000);
	if (args !== undefined && shown.includes("[preview truncated]")) throw new Error(`${label} arguments exceed the approval preview limit; the tool was not executed.`);
	print("");
	uiPrint(`${uiText(`${label} permission requested`, "warning", true)}${subject ? ` ${uiText(subject, "pale")}` : ""}`);
	if (shown) uiPrint(uiText(shown, "pale"));
	const answer = await interactiveTerminal.question(question);
	return ["y", "yes"].includes(answer.trim().toLowerCase());
}
