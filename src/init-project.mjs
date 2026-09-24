import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { MAX_READ_BYTES } from "./workspace.mjs";
import { redactLikelySecrets } from "./secrets.mjs";

const MAX_FILES = 24;
const MAX_FILE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 64_000;
const PRIORITY_FILES = new Map([
	["readme.md", 0], ["readme", 0], ["package.json", 1], ["pyproject.toml", 1],
	["requirements.txt", 1], ["cargo.toml", 1], ["go.mod", 1], ["pom.xml", 1],
	["build.gradle", 1], ["build.gradle.kts", 1], ["composer.json", 1], ["gemfile", 1],
	["makefile", 1], ["cmakelists.txt", 1], ["tsconfig.json", 2], ["dockerfile", 2],
	["vite.config.js", 2], ["vite.config.mjs", 2], ["vite.config.ts", 2],
	["next.config.js", 2], ["next.config.mjs", 2], ["next.config.ts", 2],
]);
const SOURCE_EXTENSIONS = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|php|py|rb|rs|sh|sql|swift|ts|tsx|vue|svelte|html|css)$/i;
const TEXT_EXTENSIONS = /\.(?:md|txt|json|toml|ya?ml|xml|gradle|properties|c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|php|py|rb|rs|sh|sql|swift|ts|tsx|vue|svelte|html|css)$/i;
const PROJECT_DIRECTORIES = new Set(["src", "app", "lib", "cmd", "server", "client", "packages", "apps", "pages", "api", "web", "backend", "frontend"]);

export function initCandidateScore(name, nestedDepth) {
	const lowerName = name.toLowerCase();
	if (lowerName === "agents.md" || lowerName.startsWith(".env") || lowerName.endsWith(".lock")) return null;
	if (/(?:secret|credential|private[-_.]?key)/i.test(name)) return null;
	const priority = PRIORITY_FILES.get(lowerName);
	if (priority !== undefined) return priority + nestedDepth * 3;
	if (!TEXT_EXTENSIONS.test(name)) return null;
	if (!SOURCE_EXTENSIONS.test(name) || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(name)) return null;
	if (/^(?:index|main|app|server|cli|lib)\.[^.]+$/i.test(name)) return 5 + nestedDepth * 3;
	if (nestedDepth <= 1 && /^(?:vite|next|webpack|rollup|eslint|prettier|postcss)\.config\.[^.]+$/i.test(name)) return 8;
	return null;
}

export async function collectProjectEssentials({ rootDirectory, resolveWorkspacePath, assertWorkspacePath }) {
	const candidates = new Map();
	const addCandidate = (path, name, depth) => {
		const relativePath = relative(rootDirectory, path).split(sep).join("/");
		const score = initCandidateScore(name, depth);
		if (score === null) return;
		candidates.set(relativePath, Math.min(candidates.get(relativePath) ?? Number.POSITIVE_INFINITY, score));
	};

	const rootEntries = await readdir(rootDirectory, { withFileTypes: true });
	for (const entry of rootEntries) {
		if (entry.isSymbolicLink()) continue;
		const path = join(rootDirectory, entry.name);
		if (entry.isFile()) addCandidate(path, entry.name, 0);
		if (!entry.isDirectory() || !PROJECT_DIRECTORIES.has(entry.name.toLowerCase())) continue;
		let firstLevel;
		try {
			firstLevel = await readdir(path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of firstLevel) {
			if (child.isSymbolicLink()) continue;
			const childPath = join(path, child.name);
			if (child.isFile()) addCandidate(childPath, child.name, 1);
			if (child.isDirectory() && ["packages", "apps", "cmd"].includes(entry.name.toLowerCase())) {
				let secondLevel;
				try {
					secondLevel = await readdir(childPath, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const nested of secondLevel) {
					if (nested.isFile() && !nested.isSymbolicLink()) addCandidate(join(childPath, nested.name), nested.name, 2);
				}
			}
		}
	}

	const selected = [...candidates.entries()]
		.sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
		.slice(0, MAX_FILES);
	const files = [];
	let totalChars = 0;
	for (const [relativePath] of selected) {
		if (totalChars >= MAX_TOTAL_CHARS) break;
		const target = resolveWorkspacePath(relativePath);
		try {
			await assertWorkspacePath(target);
			const info = await stat(target);
			if (!info.isFile() || info.size > MAX_READ_BYTES || info.nlink > 1) continue;
			const fullContent = await readFile(target, "utf8");
			if (fullContent.includes("\0")) continue;
			const safeContent = redactLikelySecrets(fullContent);
			const remaining = MAX_TOTAL_CHARS - totalChars;
			const excerpt = safeContent.slice(0, Math.min(MAX_FILE_CHARS, remaining));
			files.push({ path: relativePath, content: excerpt, truncated: excerpt.length < safeContent.length });
			totalChars += excerpt.length;
		} catch {
			// Unreadable, missing, or unsafe project files are skipped.
		}
	}
	return { files, candidateCount: candidates.size };
}
