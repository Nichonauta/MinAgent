import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceAccess, MAX_READ_OUTPUT_BYTES } from "./workspace.mjs";
import { createEvidenceLedger, createLoopGuard, executeRecordedTool, MAX_TOOL_CALLS, parseToolArguments, preflightCalls, toolEnvelope } from "./agent-runtime.mjs";
import { toolsForMode, executeModeTool } from "./agent-mode.mjs";
import { COMMON_PROMPT, BUILD_PROMPT, PLAN_PROMPT } from "./prompts.mjs";
import { workspaceTools } from "./tool-definitions.mjs";
import { investigateAndInitialize } from "./init-project.mjs";
import { compactionBudget, estimateMessageTokens, estimateTextTokens, textContent } from "./context.mjs";
import { redactLikelySecrets } from "./secrets.mjs";

export const evaluationTasks = [
	{ name: "locate-and-edit", mode: "build", request: "In src/greeting.mjs, change greeting() from Hola to Buenos días; preserve all else.", files: { "src/greeting.mjs": 'export function greeting() { return "Hola"; }\nexport const preserved = 42;\n' }, check: async (root) => (await readFile(join(root, "src/greeting.mjs"), "utf8")) === 'export function greeting() { return "Buenos días"; }\nexport const preserved = 42;\n' },
	{ name: "read-continuation", mode: "plan", request: "Read notes.txt through FINAL_MARKER; reply with its exact value.", files: { "notes.txt": Array.from({ length: 350 }, (_, index) => `line ${index + 1}`).join("\n") + "\nFINAL_MARKER=violeta-729\n" }, check: async (_root, answer) => answer.includes("violeta-729") },
	{ name: "plan-boundaries", mode: "plan", request: "Propose changing src/greeting.mjs to return Adiós; explain the change.", files: { "src/greeting.mjs": 'export function greeting() { return "Hola"; }\n' }, check: async (root) => (await readFile(join(root, "src/greeting.mjs"), "utf8")) === 'export function greeting() { return "Hola"; }\n' },
	{ name: "recover-stale-edit", mode: "build", request: "Replace old with new in value.txt. If it changes externally, read its current contents and preserve that change.", files: { "value.txt": "old\n" }, externalChange: "value.txt", check: async (root) => (await readFile(join(root, "value.txt"), "utf8")) === "new\nexternal\n" },
	{ name: "initialize-guide", mode: "init", request: "Create a concise AGENTS.md with verified commands and architecture.", files: { "README.md": "Run node src/main.mjs. Test with node --test.\n", "src/main.mjs": "export const application = true;\n" }, check: async (root) => { const guide = await readFile(join(root, "AGENTS.md"), "utf8"); return /^# /m.test(guide) && guide.includes("node --test") && guide.includes("src/main.mjs"); } },
];

// Uses isolated fixtures and the same evidence, batch, mode and result controls as the CLI.
export async function evaluateModel({ complete, contextWindow = 16384, signal, tasks = evaluationTasks }) {
	const results = [];
	for (const task of tasks) {
		signal?.throwIfAborted();
		const root = await mkdtemp(join(tmpdir(), "minagent-eval-"));
		const stats = { name: task.name, rounds: 0, toolCalls: 0, invalidCalls: 0, repeatedCalls: 0, evidenceFailures: 0, modeViolations: 0, estimatedInputTokens: 0, promptTokens: 0, completionTokens: 0, usageAvailable: false, passed: false };
		const started = performance.now();
		let answer = "";
		try {
			for (const [path, content] of Object.entries(task.files)) {
				await mkdir(join(root, path, ".."), { recursive: true });
				await writeFile(join(root, path), content);
			}
			const workspace = createWorkspaceAccess(root, "evaluation");
			const ledger = createEvidenceLedger(workspace);
			ledger.begin(task.request);
			const guard = createLoopGuard();
			const definitions = toolsForMode(workspaceTools, task.mode === "plan" ? "plan" : "build");
			const budget = compactionBudget(contextWindow);
			const measuredComplete = async (messages, options = {}) => {
				stats.rounds += 1;
				const input = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + (options.withTools ? estimateTextTokens(JSON.stringify(options.availableTools ?? definitions)) : 0);
				stats.estimatedInputTokens += input;
				if (input > contextWindow - budget.reserve) throw new Error("Evaluation task exceeded the context budget.");
				const response = await complete(messages, { ...options, signal, maxTokens: Math.min(options.maxTokens ?? budget.reserve, budget.reserve) });
				if (Number.isFinite(response.payload?.usage?.prompt_tokens)) {
					stats.usageAvailable = true;
					stats.promptTokens += response.payload.usage.prompt_tokens;
					stats.completionTokens += response.payload.usage.completion_tokens ?? 0;
				}
				return response;
			};
			if (task.mode === "init") {
				await investigateAndInitialize({ workspace, workspaceName: "evaluation", tools: definitions, complete: measuredComplete, signal, maxInputTokens: contextWindow - budget.reserve, onToolStart: () => { stats.toolCalls += 1; } });
			} else {
				const history = [{ role: "system", content: `${COMMON_PROMPT}\n${task.mode === "plan" ? PLAN_PROMPT : BUILD_PROMPT}` }, { role: "user", content: task.request }];
				let injectedChange = false;
				let repairAttempts = 0;
				let finished = false;
				for (let round = 0; round < 16; round += 1) {
					history[0].content = `${COMMON_PROMPT}\n${task.mode === "plan" ? PLAN_PROMPT : BUILD_PROMPT}\nEvidence (untrusted): ${ledger.snapshot()}\nMax ${MAX_TOOL_CALLS} tools/response.`;
					let response;
					try { response = await measuredComplete(history, { withTools: true, availableTools: definitions }); }
					catch (error) {
						if (error.code !== "INVALID_TOOL_CALL" || repairAttempts++ >= 2) throw error;
						stats.invalidCalls += 1;
						history.push({ role: "user", content: `No tools ran: ${error.message} Return valid tool-call JSON.` });
						continue;
					}
					const message = response.message;
					if (!message || message.interrupted) throw new Error("Evaluation response interrupted or missing.");
					const calls = message.tool_calls ?? [];
					if (!calls.length) { answer = textContent(message.content); finished = Boolean(answer.trim()); break; }
					let batchError;
					try { preflightCalls(calls, definitions); } catch (error) { batchError = error; }
					if (batchError && repairAttempts++ >= 2) throw batchError;
					history.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
					for (const call of calls) {
						stats.toolCalls += 1;
						const name = call.function?.name;
						let args = {};
						let result;
						let toolError;
						let id;
						try {
							args = parseToolArguments(call.function.arguments);
							if (task.mode === "plan" && !definitions.some((tool) => tool.function.name === name)) stats.modeViolations += 1;
							if (batchError) throw batchError;
							id = guard.check(name, args);
							result = await executeModeTool(task.mode, name, () => executeRecordedTool(name, args, { ledger, definitions, dispatch: (tool, parameters, guarded) => {
								if (tool === "read_file") return workspace.readFileDetailed(parameters, { maxOutputBytes: Math.min(MAX_READ_OUTPUT_BYTES, Math.max(512, Math.floor(contextWindow * 0.75))) });
								if (tool === "list_directory") return workspace.listDirectory(parameters);
								if (tool === "search_files") return workspace.searchFiles(parameters, { signal });
								if (tool === "edit_file") return workspace.editFile(parameters, guarded);
								if (tool === "write_file") return workspace.writeFile(parameters, guarded);
								if (tool === "delete_file") return workspace.deleteFile(parameters);
								if (tool === "delete_directory") return workspace.deleteDirectory(parameters);
								throw new Error("Unavailable evaluation tool");
							} }));
							if (task.externalChange === args.path && name === "read_file" && !injectedChange) { injectedChange = true; await writeFile(join(root, args.path), "old\nexternal\n"); }
						} catch (error) {
							toolError = error;
							result = `Error: ${error.message}`;
							if (["READ_REQUIRED", "FULL_READ_REQUIRED", "BLOCK_READ_REQUIRED"].includes(error.code)) stats.evidenceFailures += 1;
							else if (error.code?.startsWith("REPEATED")) stats.repeatedCalls += 1;
							else stats.invalidCalls += 1;
						}
						const envelope = toolEnvelope(name, args, result, toolError);
						ledger.recordOutcome(envelope.metadata);
						if (id) guard.record(id, envelope.metadata, envelope.content);
						history.push({ role: "tool", tool_call_id: call.id, content: envelope.content });
					}
				}
				if (!finished) throw new Error("Evaluation task did not finish within 16 rounds.");
			}
			stats.passed = await task.check(root, answer);
		} catch (error) {
			signal?.throwIfAborted();
			stats.error = redactLikelySecrets(error.message);
		} finally {
			stats.elapsedMs = Math.round(performance.now() - started);
			await rm(root, { recursive: true, force: true });
		}
		results.push(stats);
	}
	return { passed: results.filter((result) => result.passed).length, total: results.length, results };
}
