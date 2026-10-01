import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../src/config.mjs";
import { createOpenAiClient } from "../src/openai.mjs";
import { workspaceTools } from "../src/tool-definitions.mjs";
import { evaluateModel } from "../src/evaluation.mjs";

if (!process.argv.includes("--live")) {
	console.log("Usage: node scripts/evaluate.mjs --live\nUses the configured API with isolated temporary fixtures. Output is JSON metrics; no repository files are modified.");
} else {
	const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "../src");
	const config = await loadConfiguration({ appDirectory });
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	const client = createOpenAiClient({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, tools: workspaceTools });
	const output = await evaluateModel({ complete: (messages, options) => client.complete(messages, options), contextWindow: config.contextWindow, signal: controller.signal });
	console.log(JSON.stringify({ model: config.model, ...output }, null, 2));
	if (output.passed !== output.total) process.exitCode = 1;
}
