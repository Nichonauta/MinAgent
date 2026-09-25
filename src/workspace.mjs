import { randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rm,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectImageMimeType } from "./image.mjs";

export const MAX_READ_BYTES = 10 * 1024 * 1024;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;
export const MAX_READ_OUTPUT_BYTES = 48 * 1024;
export const MAX_READ_LINES = 300;
const MAX_AGENTS_BYTES = 64 * 1024;
const MAX_INVENTORY_ENTRIES = 10_000;
const MAX_INVENTORY_CHARS = 128 * 1024;
const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", ".next", ".cache", "dist", "build", "coverage"]);

export function createWorkspaceAccess(rootDirectory, workspaceName, listLimit = -1) {
	function isWithinRoot(candidate) {
		const rel = relative(rootDirectory, candidate);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}

	function resolvePath(input) {
		if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
			throw new Error("A non-empty file path is required.");
		}
		const absolute = isAbsolute(input);
		let candidate = absolute ? resolve(input) : resolve(rootDirectory, input);
		if (!isWithinRoot(candidate)) throw new Error("Path is outside the current workspace.");
		const explicitlyRelative = /^\.[\\/]/.test(input);
		if (!absolute && !explicitlyRelative) {
			const parts = input.split(process.platform === "win32" ? /[\\/]/ : /\//).filter((part) => part && part !== ".");
			const namesWorkspace = process.platform === "win32"
				? parts[0]?.toLowerCase() === workspaceName.toLowerCase()
				: parts[0] === workspaceName;
			if (namesWorkspace && !parts.includes("..")) {
				// A real child with this name takes precedence over the redundant workspace prefix.
				let childExists = true;
				try {
					lstatSync(join(rootDirectory, parts[0]));
				} catch (error) {
					if (error?.code === "ENOENT" || error?.code === "ENOTDIR") childExists = false;
					else throw error;
				}
				if (!childExists) candidate = resolve(rootDirectory, ...parts.slice(1));
			}
		}
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
		if (target === rootDirectory) {
			throw new Error(`${action} requires a file path; ${workspaceName} names the workspace directory.`);
		}
		const entry = await lstat(target);
		if (!entry.isFile()) throw new Error(`${action} only works on regular files.`);
		if (entry.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
		return entry;
	}

	function sameFile(left, right) {
		return left.dev === right.dev && left.ino === right.ino;
	}

	function sameVersion(left, right) {
		return sameFile(left, right) && left.size === right.size
			&& left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
	}

	async function readRegularBuffer(target, action) {
		const before = await regularFile(target, action);
		if (before.size > MAX_READ_BYTES) throw new Error(`File is larger than the ${MAX_READ_BYTES} byte ${action} limit.`);
		const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		try {
			const entry = await handle.stat();
			if (!entry.isFile() || entry.nlink > 1 || !sameFile(before, entry)) {
				throw new Error("The file changed while it was being opened.");
			}
			const resolved = await realpath(target);
			if (!isWithinRoot(resolved)) throw new Error("Path resolved outside the current workspace.");
			const current = await lstat(target);
			if (!current.isFile() || current.nlink > 1 || !sameFile(entry, current)) {
				throw new Error("The file changed while it was being opened.");
			}
			const buffer = await handle.readFile();
			if (buffer.length > MAX_READ_BYTES) throw new Error(`File grew beyond the ${MAX_READ_BYTES} byte ${action} limit while being read.`);
			const after = await lstat(target);
			if (!after.isFile() || !sameVersion(current, after)) throw new Error("The file changed while it was being read.");
			return { entry: after, buffer };
		} finally {
			await handle.close();
		}
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
		const { entry, buffer } = await readRegularBuffer(target, action);
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
			const tempHandle = await open(tempPath, "wx", previousEntry ? previousEntry.mode & 0o777 : 0o666);
			created = true;
			try {
				const resolvedTemp = await realpath(tempPath);
				if (!isWithinRoot(resolvedTemp)) throw new Error("Temporary file resolved outside the current workspace.");
				await tempHandle.writeFile(bytes);
			} finally {
				await tempHandle.close();
			}
			await assertPath(target);
			try {
				const current = await lstat(target);
				if (current.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
				if (current.isDirectory()) throw new Error("The target path is a directory.");
				if (!current.isFile()) throw new Error("Only regular files can be overwritten.");
				if (current.nlink > 1) throw new Error("Hard-linked files are blocked to keep access inside the workspace.");
				if (!previousEntry || !sameVersion(previousEntry, current)) throw new Error("The target file changed before it could be replaced.");
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
				if (previousEntry) throw new Error("The target file disappeared before it could be replaced.");
			}
			await assertPath(directory);
			if (!isWithinRoot(await realpath(directory))) throw new Error("Target directory resolved outside the current workspace.");
			await rename(tempPath, target);
			created = false;
		} finally {
			if (created) {
				try {
					if (isWithinRoot(await realpath(tempPath))) await unlink(tempPath);
				} catch {
					// The temporary file may already have been removed or moved.
				}
			}
		}
	}

	async function verifyWrittenText(target, expected) {
		try {
			const { content } = await readText(target, "write verification");
			if (content !== expected) throw new Error("Written file does not match the requested content.");
		} catch (error) {
			error.mayHaveChanged = true;
			throw error;
		}
	}

	async function readRawFile(input) {
		const { buffer } = await readRegularBuffer(resolvePath(input), "attachment");
		return buffer;
	}

	async function readFileTool(args, { imageEnabled = false } = {}) {
		const target = resolvePath(args.path);
		const { buffer } = await readRegularBuffer(target, "read_file");
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
		const column = args.column ?? 1;
		const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
		if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be an integer of at least 1.");
		if (!Number.isInteger(column) || column < 1) throw new Error("column must be an integer of at least 1.");
		if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be an integer of at least 1.");
		if (offset > lines.length) throw new Error(`offset is beyond the end of the file (${lines.length} lines).`);
		let output = "";
		let outputBytes = 0;
		let returnedLines = 0;
		const contentBudget = MAX_READ_OUTPUT_BYTES - 160;
		for (let lineIndex = offset - 1; lineIndex < Math.min(lines.length, offset - 1 + limit); lineIndex += 1) {
			const line = lines[lineIndex];
			const startColumn = lineIndex === offset - 1 ? column : 1;
			const prefix = returnedLines === 0 ? "" : "\n";
			let fragment = "";
			let fragmentBytes = 0;
			let currentColumn = 1;
			for (const character of line) {
				if (currentColumn < startColumn) {
					currentColumn += 1;
					continue;
				}
				const characterBytes = Buffer.byteLength(character, "utf8");
				if (outputBytes + Buffer.byteLength(prefix) + fragmentBytes + characterBytes > contentBudget) {
					output += `${prefix}${fragment}`;
					return `${output}\n\n[Read stopped at the output limit. Continue with offset=${lineIndex + 1}, column=${currentColumn}.]`;
				}
				fragment += character;
				fragmentBytes += characterBytes;
				currentColumn += 1;
			}
			if (startColumn > currentColumn) throw new Error(`column is beyond the end of line ${lineIndex + 1}.`);
			if (outputBytes + Buffer.byteLength(prefix) + fragmentBytes > contentBudget) {
				return `${output}\n\n[Read stopped at the output limit. Continue with offset=${lineIndex + 1}, column=${startColumn}.]`;
			}
			output += `${prefix}${fragment}`;
			outputBytes += Buffer.byteLength(prefix) + fragmentBytes;
			returnedLines += 1;
		}
		const nextOffset = offset + returnedLines;
		if (nextOffset <= lines.length) output += `\n\n[${lines.length - nextOffset + 1} more lines. Continue with offset=${nextOffset}.]`;
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
		await verifyWrittenText(target, changed);
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
		await verifyWrittenText(target, args.content);
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
		if (!isWithinRoot(await realpath(dirname(target)))) throw new Error("Parent directory resolved outside the current workspace.");
		const current = await lstat(target);
		if (!current.isFile() || !sameVersion(entry, current)) throw new Error("The file changed before it could be deleted.");
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
		if (!isWithinRoot(await realpath(target))) throw new Error("Directory resolved outside the current workspace.");
		const current = await lstat(target);
		if (!current.isDirectory() || !sameFile(entry, current)) throw new Error("The directory changed before it could be deleted.");
		await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
		return `Deleted directory ${args.path} and its contents.`;
	}

	async function refreshInventory() {
		const lines = [
			"## Current workspace inventory (refreshed before each model request; common generated directories are excluded)",
			`Current directory: ${workspaceName}`,
			`Per-directory listing limit: ${listLimit === -1 ? "unlimited" : listLimit}`,
		];
		const filePaths = [];
		let omittedEntries = 0;
		let visitedEntries = 0;
		let listedChars = lines.join("\n").length;
		let inventoryFull = false;
		function addLine(line) {
			if (listedChars + line.length + 1 > MAX_INVENTORY_CHARS) {
				inventoryFull = true;
				return;
			}
			lines.push(line);
			listedChars += line.length + 1;
		}
		async function appendDirectory(directoryPath, indent) {
			if (inventoryFull || visitedEntries >= MAX_INVENTORY_ENTRIES) return;
			let entries;
			try {
				entries = await readdir(directoryPath, { withFileTypes: true });
			} catch (error) {
				addLine(`${indent}[Could not list this directory: ${error?.code || "access error"}]`);
				return;
			}
			entries = entries.filter((entry) => !(entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())));
			entries.sort((left, right) => left.name.localeCompare(right.name));
			const visibleEntries = listLimit === -1 ? entries : entries.slice(0, listLimit);
			omittedEntries += entries.length - visibleEntries.length;
			for (const entry of visibleEntries) {
				if (inventoryFull || visitedEntries >= MAX_INVENTORY_ENTRIES) {
					inventoryFull = true;
					break;
				}
				visitedEntries += 1;
				const childPath = join(directoryPath, entry.name);
				if (entry.isSymbolicLink()) {
					addLine(`${indent}[LINK, not traversed] ${entry.name}`);
				} else if (entry.isDirectory()) {
					addLine(`${indent}[DIR] ${entry.name}/`);
					await appendDirectory(childPath, `${indent}  `);
				} else if (entry.isFile()) {
					filePaths.push(relativeName(childPath));
					addLine(`${indent}[FILE] ${entry.name}`);
				} else {
					addLine(`${indent}[SPECIAL, not readable] ${entry.name}`);
				}
			}
		}
		await appendDirectory(rootDirectory, "");
		if (omittedEntries > 0) lines.push(`[${omittedEntries} entries omitted by WORKSPACE_LIST_LIMIT]`);
		if (inventoryFull) lines.push(`[Inventory stopped at ${MAX_INVENTORY_ENTRIES} entries or ${MAX_INVENTORY_CHARS} characters.]`);
		let guidance = "## AGENTS.md project guidance\nNo AGENTS.md exists at the workspace root.";
		let agentsContent = "";
		let agentsExists = false;
		try {
			const target = join(rootDirectory, "AGENTS.md");
			await assertPath(target);
			const entry = await lstat(target);
			if (!entry.isFile() || entry.nlink > 1) {
				guidance = "## AGENTS.md project guidance\nAGENTS.md exists at the workspace root but is not a regular unlinked file.";
			} else if (entry.size > MAX_AGENTS_BYTES) {
				guidance = `## AGENTS.md project guidance\nAGENTS.md exceeds the ${MAX_AGENTS_BYTES} byte limit.`;
			} else {
				const { buffer } = await readRegularBuffer(target, "AGENTS.md");
				if (buffer.length > MAX_AGENTS_BYTES) throw new Error("AGENTS.md grew beyond its size limit.");
				agentsContent = decodeText(buffer, "AGENTS.md");
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
		readRawFile,
		editFile: editFileTool,
		writeFile: writeFileTool,
		deleteFile: deleteFileTool,
		deleteDirectory: deleteDirectoryTool,
		refreshInventory,
	};
}
