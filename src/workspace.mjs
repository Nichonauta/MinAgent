import { randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_READ_BYTES = 10 * 1024 * 1024;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;
export const MAX_READ_OUTPUT_BYTES = 48 * 1024;
export const MAX_READ_LINES = 300;

export function createWorkspaceAccess(rootDirectory, workspaceName, listLimit = -1) {
	function isWithinRoot(candidate) {
		const rel = relative(rootDirectory, candidate);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}

	function resolvePath(input) {
		if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
			throw new Error("A non-empty file path is required.");
		}
		const candidate = isAbsolute(input) ? resolve(input) : resolve(rootDirectory, input);
		if (!isWithinRoot(candidate)) throw new Error("Path is outside the current workspace.");
		if (process.platform === "win32") {
			const parts = relative(rootDirectory, candidate).split(/[\\/]/).filter(Boolean);
			for (const part of parts) {
				if (part.includes(":") || /[. ]$/.test(part)) throw new Error("This Windows path form is not allowed.");
				const deviceName = part.split(".")[0];
				if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceName)) throw new Error("Windows device paths are not allowed.");
			}
		}
		return candidate;
	}

	async function assertPath(candidate) {
		if (!isWithinRoot(candidate)) throw new Error("Path is outside the current workspace.");
		const rel = relative(rootDirectory, candidate);
		if (rel === "") return;
		let current = rootDirectory;
		for (const part of rel.split(sep)) {
			if (!part) continue;
			current = join(current, part);
			let entry;
			try {
				entry = await lstat(current);
			} catch (error) {
				if (error?.code === "ENOENT") return;
				throw error;
			}
			if (entry.isSymbolicLink()) {
				throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
			}
		}
	}

	function relativeName(target) {
		return relative(rootDirectory, target).split(sep).join("/");
	}

	async function regularFile(target, action) {
		await assertPath(target);
		const entry = await lstat(target);
		if (!entry.isFile()) throw new Error(`${action} only works on regular files.`);
		if (entry.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
		return entry;
	}

	function decodeText(buffer, action) {
		if (buffer.includes(0)) throw new Error(`${action} cannot process binary files.`);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		} catch {
			throw new Error(`${action} requires a UTF-8 text file.`);
		}
	}

	async function readText(target, action) {
		const entry = await regularFile(target, action);
		if (entry.size > MAX_READ_BYTES) throw new Error(`File is larger than the ${MAX_READ_BYTES} byte ${action} limit.`);
		const buffer = await readFile(target);
		if (buffer.length > MAX_READ_BYTES) throw new Error(`File grew beyond the ${MAX_READ_BYTES} byte ${action} limit while being read.`);
		return { entry, buffer, content: decodeText(buffer, action) };
	}

	async function writeAtomically(target, content, previousEntry) {
		const bytes = Buffer.from(content, "utf8");
		if (bytes.length > MAX_WRITE_BYTES) throw new Error(`File content exceeds the ${MAX_WRITE_BYTES} byte write limit.`);
		const directory = dirname(target);
		const tempPath = join(directory, `.${basename(target)}.minagent-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
		let created = false;
		try {
			await assertPath(directory);
			await writeFile(tempPath, bytes, { flag: "wx", mode: previousEntry ? previousEntry.mode & 0o777 : 0o666 });
			created = true;
			await assertPath(target);
			try {
				const current = await lstat(target);
				if (current.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
				if (current.isDirectory()) throw new Error("The target path is a directory.");
				if (!current.isFile()) throw new Error("Only regular files can be overwritten.");
				if (current.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			await assertPath(directory);
			await rename(tempPath, target);
			created = false;
		} finally {
			if (created) await unlink(tempPath).catch(() => {});
		}
	}

	function detectImageMimeType(buffer) {
		if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
		if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
		if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
		if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
		return null;
	}

	async function readFileTool(args, { imageEnabled = false } = {}) {
		const target = resolvePath(args.path);
		const entry = await regularFile(target, "read_file");
		if (entry.size > MAX_READ_BYTES) throw new Error(`File is larger than the ${MAX_READ_BYTES} byte read limit.`);
		const buffer = await readFile(target);
		if (buffer.length > MAX_READ_BYTES) throw new Error(`File grew beyond the ${MAX_READ_BYTES} byte read limit while being read.`);
		const imageMimeType = detectImageMimeType(buffer);
		if (imageMimeType) {
			if (!imageEnabled) throw new Error("The configured model does not accept images.");
			return {
				toolText: `Read image file [${imageMimeType}] ${args.path}`,
				image: { path: args.path, mimeType: imageMimeType, data: buffer.toString("base64") },
			};
		}
		if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(args.path)) {
			throw new Error("Image format not recognized. Supported images are PNG, JPEG, GIF, and WebP.");
		}
		const content = decodeText(buffer, "read_file");
		const lines = content.split("\n");
		const offset = args.offset ?? 1;
		const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
		if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be an integer of at least 1.");
		if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be an integer of at least 1.");
		if (offset > lines.length) throw new Error(`offset is beyond the end of the file (${lines.length} lines).`);
		let output = "";
		let returnedLines = 0;
		for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
			const next = returnedLines === 0 ? line : `\n${line}`;
			if (Buffer.byteLength(output + next, "utf8") > MAX_READ_OUTPUT_BYTES) {
				if (returnedLines === 0) {
					output = `${Buffer.from(line, "utf8").subarray(0, MAX_READ_OUTPUT_BYTES).toString("utf8")}\n[This line exceeds the output limit and was truncated.]`;
					returnedLines = 1;
				}
				break;
			}
			output += next;
			returnedLines += 1;
		}
		const nextOffset = offset + returnedLines;
		if (nextOffset <= lines.length) output += `\n\n[Read stopped at the output limit. Continue with offset=${nextOffset}.]`;
		else if (offset - 1 + limit < lines.length) output += `\n\n[${lines.length - (offset - 1 + limit)} more lines. Continue with offset=${offset + limit}.]`;
		return output;
	}

	async function editFileTool(args) {
		if (typeof args.old_text !== "string" || args.old_text.length === 0) throw new Error("old_text must be a non-empty string.");
		if (typeof args.new_text !== "string") throw new Error("new_text must be a string.");
		if (Buffer.byteLength(args.old_text, "utf8") > MAX_WRITE_BYTES || Buffer.byteLength(args.new_text, "utf8") > MAX_WRITE_BYTES) {
			throw new Error(`old_text and new_text must each fit within the ${MAX_WRITE_BYTES} byte edit limit.`);
		}
		const target = resolvePath(args.path);
		const { content, entry } = await readText(target, "edit_file");
		const firstIndex = content.indexOf(args.old_text);
		if (firstIndex < 0) throw new Error(`old_text was not found in ${args.path}; no changes were made. Reread this path with read_file, then rebuild the edit from its current contents.`);
		if (content.indexOf(args.old_text, firstIndex + args.old_text.length) >= 0) throw new Error(`old_text occurs more than once in ${args.path}; no changes were made. Reread this path with read_file and choose a unique exact text block.`);
		const changed = content.slice(0, firstIndex) + args.new_text + content.slice(firstIndex + args.old_text.length);
		await writeAtomically(target, changed, entry);
		return `Updated ${args.path}.`;
	}

	async function writeFileTool(args) {
		if (typeof args.content !== "string") throw new Error("content must be a string.");
		if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_BYTES) throw new Error(`File content exceeds the ${MAX_WRITE_BYTES} byte write limit.`);
		const target = resolvePath(args.path);
		await assertPath(target);
		await mkdir(dirname(target), { recursive: true });
		await assertPath(target);
		let previousEntry;
		try {
			previousEntry = await lstat(target);
			if (previousEntry.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
			if (previousEntry.isDirectory()) throw new Error("The target path is a directory.");
			if (!previousEntry.isFile()) throw new Error("Only regular files can be overwritten.");
			if (previousEntry.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await writeAtomically(target, args.content, previousEntry);
		return `Wrote ${args.path}.`;
	}

	async function deleteFileTool(args) {
		const target = resolvePath(args.path);
		await assertPath(target);
		const entry = await lstat(target);
		if (entry.isDirectory()) throw new Error("Directories cannot be deleted. delete_file removes files only.");
		if (entry.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
		if (!entry.isFile()) throw new Error("Only regular files can be deleted.");
		if (entry.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
		await unlink(target);
		return `Deleted ${args.path}.`;
	}

	async function validateDeletableDirectory(directoryPath) {
		const entry = await lstat(directoryPath);
		if (entry.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked inside deletable directories.");
		if (entry.isDirectory()) {
			for (const child of await readdir(directoryPath, { withFileTypes: true })) await validateDeletableDirectory(join(directoryPath, child.name));
			return;
		}
		if (!entry.isFile()) throw new Error("Directories containing special files cannot be deleted.");
		if (entry.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
	}

	async function deleteDirectoryTool(args) {
		const target = resolvePath(args.path);
		const isRoot = process.platform === "win32" ? target.toLowerCase() === rootDirectory.toLowerCase() : target === rootDirectory;
		if (isRoot) throw new Error("The workspace root cannot be deleted.");
		await assertPath(target);
		const entry = await lstat(target);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("delete_directory only works on a regular subdirectory.");
		await validateDeletableDirectory(target);
		await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
		return `Deleted directory ${args.path} and its contents.`;
	}

	async function refreshInventory() {
		const lines = [
			"## Current workspace inventory (refreshed before each model request)",
			`Current directory: ${workspaceName}`,
			`Per-directory listing limit: ${listLimit === -1 ? "unlimited" : listLimit}`,
		];
		const filePaths = [];
		let omittedEntries = 0;
		async function appendDirectory(directoryPath, indent, includeListing = true) {
			let entries;
			try {
				entries = await readdir(directoryPath, { withFileTypes: true });
			} catch (error) {
				if (includeListing) lines.push(`${indent}[Could not list this directory: ${error?.code || "access error"}]`);
				return;
			}
			entries.sort((left, right) => left.name.localeCompare(right.name));
			const visibleEntries = includeListing ? (listLimit === -1 ? entries : entries.slice(0, listLimit)) : [];
			const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
			if (includeListing) omittedEntries += entries.length - visibleEntries.length;
			for (const entry of entries) {
				const visible = visibleNames.has(entry.name);
				const childPath = join(directoryPath, entry.name);
				if (entry.isSymbolicLink()) {
					if (visible) lines.push(`${indent}[LINK, not traversed] ${entry.name}`);
				} else if (entry.isDirectory()) {
					if (visible) lines.push(`${indent}[DIR] ${entry.name}/`);
					await appendDirectory(childPath, visible ? `${indent}  ` : indent, visible);
				} else if (entry.isFile()) {
					filePaths.push(relativeName(childPath));
					if (visible) lines.push(`${indent}[FILE] ${entry.name}`);
				} else if (visible) {
					lines.push(`${indent}[SPECIAL, not readable] ${entry.name}`);
				}
			}
		}
		await appendDirectory(rootDirectory, "");
		if (omittedEntries > 0) lines.push(`[${omittedEntries} entries omitted by WORKSPACE_LIST_LIMIT]`);
		let guidance = "## AGENTS.md project guidance\nNo AGENTS.md exists at the workspace root.";
		let agentsContent = "";
		let agentsExists = false;
		try {
			const target = join(rootDirectory, "AGENTS.md");
			await assertPath(target);
			const entry = await lstat(target);
			if (!entry.isFile() || entry.nlink > 1) {
				guidance = "## AGENTS.md project guidance\nAGENTS.md exists at the workspace root but is not a regular unlinked file.";
			} else {
				agentsContent = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target));
				agentsExists = true;
				guidance = `## AGENTS.md project guidance (reloaded before each model request)\n${agentsContent}`;
			}
		} catch (error) {
			if (error?.code !== "ENOENT") guidance = `## AGENTS.md project guidance\nCould not load AGENTS.md: ${error?.code || error.message}`;
		}
		return {
			snapshot: lines.join("\n"),
			files: filePaths.sort((left, right) => left.localeCompare(right)),
			agentsContext: guidance,
			agentsContent,
			agentsExists,
		};
	}

	return {
		rootDirectory,
		workspaceName,
		resolvePath,
		assertPath,
		readFile: readFileTool,
		editFile: editFileTool,
		writeFile: writeFileTool,
		deleteFile: deleteFileTool,
		deleteDirectory: deleteDirectoryTool,
		refreshInventory,
	};
}
