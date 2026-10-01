import { randomBytes, createHash } from "node:crypto";
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
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { detectImageMimeType } from "./image.mjs";
import { searchWorkspace } from "./search.mjs";
import { EXCLUDED_DIRECTORIES } from "./workspace-policy.mjs";

const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
export const MAX_READ_OUTPUT_BYTES = 48 * 1024;
export const MAX_READ_LINES = 300;
const MAX_AGENTS_BYTES = 64 * 1024;
const MAX_AUTOCOMPLETE_ENTRIES = 10_000;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_DIRECTORY_OUTPUT_BYTES = 50 * 1024;

export function createWorkspaceAccess(rootDirectory, workspaceName) {
	async function isWithinResolvedRoot(candidate) {
		const canonicalRoot = await realpath(rootDirectory);
		const rel = relative(canonicalRoot, candidate);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}
	function isWithinRoot(candidate) {
		const rel = relative(rootDirectory, candidate);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}

	function resolvePath(input, { allowOutside = false } = {}) {
		if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
			throw new Error("A non-empty file path is required.");
		}
		const absolute = isAbsolute(input);
		let candidate = absolute ? resolve(input) : resolve(rootDirectory, input);
		if (!allowOutside && !isWithinRoot(candidate)) throw new Error("Path is outside the current workspace.");
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
		if (!allowOutside && !isWithinRoot(candidate)) throw new Error("Path is outside the current workspace.");
		if (process.platform === "win32") {
			if (/^[\\/]{2}[?.][\\/]/.test(input)) throw new Error("Windows device paths are not allowed.");
			const baseDirectory = isWithinRoot(candidate) ? rootDirectory : parsePath(candidate).root;
			const parts = relative(baseDirectory, candidate).split(/[\\/]/).filter(Boolean);
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

	async function regularFile(target, action, { allowOutside = false } = {}) {
		if (!allowOutside || isWithinRoot(target)) await assertPath(target);
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

	async function readRegularBuffer(target, action, { allowOutside = false, maxBytes = MAX_READ_BYTES, signal } = {}) {
		signal?.throwIfAborted();
		const before = await regularFile(target, action, { allowOutside });
		if (before.size > maxBytes) {
			const error = new Error(`File is larger than the ${maxBytes} byte ${action} limit.`);
			error.code = "READ_SIZE_LIMIT";
			error.byteSize = before.size;
			throw error;
		}
		const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		try {
			const entry = await handle.stat();
			if (!entry.isFile() || entry.nlink > 1 || !sameFile(before, entry)) {
				throw new Error("The file changed while it was being opened.");
			}
			const resolved = await realpath(target);
			if (!allowOutside && !await isWithinResolvedRoot(resolved)) throw new Error("Path resolved outside the current workspace.");
			const current = await lstat(target);
			if (!current.isFile() || current.nlink > 1 || !sameFile(entry, current)) {
				throw new Error("The file changed while it was being opened.");
			}
			const buffer = await handle.readFile({ signal });
			if (buffer.length > maxBytes) throw new Error(`File grew beyond the ${maxBytes} byte ${action} limit while being read.`);
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

	async function writeAtomically(target, content, previousEntry, signal) {
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
				if (!await isWithinResolvedRoot(resolvedTemp)) throw new Error("Temporary file resolved outside the current workspace.");
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
			if (!await isWithinResolvedRoot(await realpath(directory))) throw new Error("Target directory resolved outside the current workspace.");
			signal?.throwIfAborted();
			await rename(tempPath, target);
			created = false;
		} finally {
			if (created) {
				try {
					if (await isWithinResolvedRoot(await realpath(tempPath))) await unlink(tempPath);
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

	async function readRawFile(input, { allowOutside = false, maxBytes = MAX_READ_BYTES, signal } = {}) {
		const target = resolvePath(input, { allowOutside });
		const { buffer } = await readRegularBuffer(target, "attachment", { allowOutside, maxBytes: Math.min(MAX_READ_BYTES, maxBytes), signal });
		return buffer;
	}

	async function fileState(input) {
		try {
			const { entry, buffer } = await readRegularBuffer(resolvePath(input), "file state");
			return {
				version: [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs],
				hash: createHash("sha256").update(buffer).digest("hex"),
				content: decodeText(buffer, "file state"),
			};
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			throw error;
		}
	}

	function escapeDirectoryLabel(value) {
		return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
	}

	async function listDirectoryTool(args = {}) {
		const inputPath = args.path ?? ".";
		const limit = args.limit ?? 500;
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_ENTRIES) {
			throw new Error(`limit must be an integer from 1 to ${MAX_DIRECTORY_ENTRIES}.`);
		}
		const target = resolvePath(inputPath);
		const displayPath = relativeName(target) || ".";
		const safeDisplayPath = escapeDirectoryLabel(displayPath);
		await assertPath(target);
		let directoryEntry;
		try {
			directoryEntry = await lstat(target);
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
				throw new Error(`Directory does not exist: ${JSON.stringify(safeDisplayPath)}.`);
			}
			throw new Error(`Could not inspect directory ${JSON.stringify(safeDisplayPath)}: ${error?.code || "access error"}.`);
		}
		if (directoryEntry.isSymbolicLink()) throw new Error("Symbolic links and junctions are blocked to keep file access inside the workspace.");
		if (!directoryEntry.isDirectory()) throw new Error(`list_directory requires a directory: ${JSON.stringify(safeDisplayPath)}.`);
		let resolvedDirectory;
		try {
			resolvedDirectory = await realpath(target);
		} catch (error) {
			throw new Error(`Could not verify directory ${JSON.stringify(safeDisplayPath)}: ${error?.code || "access error"}.`);
		}
		if (!await isWithinResolvedRoot(resolvedDirectory)) throw new Error("Path resolved outside the current workspace.");
		let entries;
		try {
			entries = await readdir(target, { withFileTypes: true });
		} catch (error) {
			throw new Error(`Could not list directory ${JSON.stringify(safeDisplayPath)}: ${error?.code || "access error"}.`);
		}
		let currentDirectoryEntry;
		let currentResolvedDirectory;
		try {
			currentDirectoryEntry = await lstat(target);
			currentResolvedDirectory = await realpath(target);
		} catch (error) {
			throw new Error(`Could not verify directory ${JSON.stringify(safeDisplayPath)} after listing: ${error?.code || "access error"}.`);
		}
		if (!currentDirectoryEntry.isDirectory() || !sameFile(directoryEntry, currentDirectoryEntry)
			|| !await isWithinResolvedRoot(currentResolvedDirectory)) {
			throw new Error("The directory changed while it was being listed.");
		}
		entries.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.name.localeCompare(right.name));
		const totalEntries = entries.length;
		if (totalEntries === 0) {
			return {
				toolText: `Directory: ${JSON.stringify(safeDisplayPath)}\n(empty directory)`,
				displayText: `Listed ${JSON.stringify(safeDisplayPath)} · empty directory`,
				directoryInfo: { path: displayPath, entries: [], truncated: false },
			};
		}

		const candidates = entries.slice(0, limit);
		const outputLines = [`Directory: ${JSON.stringify(safeDisplayPath)}`];
		let outputBytes = Buffer.byteLength(outputLines[0], "utf8");
		let byteLimitReached = false;
		for (const entry of candidates) {
			const kind = entry.isSymbolicLink() ? "LINK, not traversed"
				: entry.isDirectory() ? "DIR"
					: entry.isFile() ? "FILE"
						: "SPECIAL, not readable";
			const suffix = entry.isDirectory() ? "/" : "";
			const line = `[${kind}] ${escapeDirectoryLabel(entry.name)}${suffix}`;
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			if (outputBytes + lineBytes > MAX_DIRECTORY_OUTPUT_BYTES - 512) {
				byteLimitReached = true;
				break;
			}
			outputLines.push(line);
			outputBytes += lineBytes;
		}
		const shownEntries = outputLines.length - 1;
		const omittedEntries = totalEntries - shownEntries;
		if (omittedEntries > 0) {
			if (byteLimitReached) {
				outputLines.push(`[Output capped at ${MAX_DIRECTORY_OUTPUT_BYTES} bytes; ${omittedEntries} of ${totalEntries} entries were omitted. List a subdirectory to narrow the results.]`);
			} else if (limit === MAX_DIRECTORY_ENTRIES) {
				outputLines.push(`[Showing ${shownEntries} of ${totalEntries} entries; list a subdirectory to inspect the remainder beyond the ${MAX_DIRECTORY_ENTRIES}-entry limit.]`);
			} else {
				outputLines.push(`[Showing ${shownEntries} of ${totalEntries} entries. Call list_directory with a larger limit to see more.]`);
			}
		}
		const wasTruncated = omittedEntries > 0;
		return {
			toolText: outputLines.join("\n"),
			displayText: `Listed ${JSON.stringify(safeDisplayPath)} · ${shownEntries}/${totalEntries} entries${wasTruncated ? " · truncated" : ""}`,
			directoryInfo: {
				path: displayPath,
				entries: candidates.slice(0, shownEntries).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "special" })),
				truncated: wasTruncated,
			},
		};
	}

	async function readFileTool(args, { imageEnabled = false, detailed = false, maxOutputBytes = MAX_READ_OUTPUT_BYTES } = {}) {
		const target = resolvePath(args.path, { allowOutside: true });
		const { buffer } = await readRegularBuffer(target, "read_file", { allowOutside: true });
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
		let partialLine;
		let contentEnd;
		if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 512) throw new Error("Read output budget must be an integer of at least 512 bytes.");
		const contentBudget = Math.min(MAX_READ_OUTPUT_BYTES, maxOutputBytes) - 160;
		const finishRead = (nextOffset, nextColumn) => {
			const lastCompleteLine = returnedLines > 0 ? offset + returnedLines - 1 : undefined;
			const info = {
				requestedOffset: offset,
				requestedColumn: column,
				requestedLimit: limit,
				totalLines: lines.length,
				firstReturnedLine: returnedLines > 0 ? offset : partialLine?.line,
				lastReturnedLine: partialLine?.line ?? lastCompleteLine,
				returnedLines,
				partialLine,
				reachedEndOfFile: nextOffset === undefined,
				nextOffset,
				nextColumn,
			};
			if (!detailed) return output;
			const returned = partialLine
				? `${returnedLines > 0 ? `lines ${offset}–${lastCompleteLine}, then ` : ""}line ${partialLine.line}, columns ${partialLine.from}–${partialLine.to}`
				: returnedLines > 0 ? `lines ${offset}–${lastCompleteLine}` : "no content";
			const completion = info.reachedEndOfFile
				? "end of file"
				: `more available; next offset=${nextOffset}${nextColumn !== undefined ? `, column=${nextColumn}` : ""}`;
			const requestedEnd = Math.min(offset + limit - 1, lines.length);
			const displayText = `Read ${JSON.stringify(args.path)} · requested lines ${offset}–${requestedEnd}${column > 1 ? ` from column ${column}` : ""} (limit ${limit}) · returned ${returned} of ${lines.length} lines · ${completion}`;
			return { toolText: output, displayText, readInfo: info,
				readContent: output.slice(0, contentEnd ?? output.length),
				readState: { hash: createHash("sha256").update(buffer).digest("hex"),
					length: content.length, start: lines.slice(0, offset - 1).join("\n").length + (offset > 1 ? 1 : 0) + [...lines[offset - 1]].slice(0, column - 1).join("").length },
			};
		};
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
					if (fragment.length > 0) partialLine = { line: lineIndex + 1, from: startColumn, to: currentColumn - 1 };
					contentEnd = output.length;
					output += `\n\n[Read stopped at the output limit. Continue with offset=${lineIndex + 1}, column=${currentColumn}.]`;
					return finishRead(lineIndex + 1, currentColumn);
				}
				fragment += character;
				fragmentBytes += characterBytes;
				currentColumn += 1;
			}
			if (startColumn > currentColumn) throw new Error(`column is beyond the end of line ${lineIndex + 1}.`);
			if (outputBytes + Buffer.byteLength(prefix) + fragmentBytes > contentBudget) {
				contentEnd = output.length;
				output += `\n\n[Read stopped at the output limit. Continue with offset=${lineIndex + 1}, column=${startColumn}.]`;
				return finishRead(lineIndex + 1, startColumn);
			}
			output += `${prefix}${fragment}`;
			outputBytes += Buffer.byteLength(prefix) + fragmentBytes;
			returnedLines += 1;
		}
		const nextOffset = offset + returnedLines;
		if (nextOffset <= lines.length) {
			contentEnd = output.length;
			output += `\n\n[${lines.length - nextOffset + 1} more lines. Continue with offset=${nextOffset}.]`;
			return finishRead(nextOffset);
		}
		return finishRead(undefined);
	}

	async function editFileTool(args, options = {}) {
		if (typeof args.old_text !== "string" || args.old_text.length === 0) throw new Error("old_text must be a non-empty string.");
		if (typeof args.new_text !== "string") throw new Error("new_text must be a string.");
		if (Buffer.byteLength(args.old_text, "utf8") > MAX_WRITE_BYTES || Buffer.byteLength(args.new_text, "utf8") > MAX_WRITE_BYTES) {
			throw new Error(`old_text and new_text must each fit within the ${MAX_WRITE_BYTES} byte edit limit.`);
		}
		const target = resolvePath(args.path);
		const { content, entry, buffer } = await readText(target, "edit_file");
		if (options.expectedHash && createHash("sha256").update(buffer).digest("hex") !== options.expectedHash) throw new Error("The target changed since inspection; reread it before editing.");
		const firstIndex = content.indexOf(args.old_text);
		if (firstIndex < 0) throw new Error(`old_text not found in ${args.path}; no changes made. Reread it, then rebuild the edit.`);
		if (content.indexOf(args.old_text, firstIndex + args.old_text.length) >= 0) throw new Error(`old_text is not unique in ${args.path}; no changes made. Reread it and choose a unique block.`);
		const changed = content.slice(0, firstIndex) + args.new_text + content.slice(firstIndex + args.old_text.length);
		await writeAtomically(target, changed, entry);
		await verifyWrittenText(target, changed);
		return `Updated ${args.path}.`;
	}

	async function writeFileTool(args, options = {}) {
		if (typeof args.content !== "string") throw new Error("content must be a string.");
		if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_BYTES) throw new Error(`File content exceeds the ${MAX_WRITE_BYTES} byte write limit.`);
		options.signal?.throwIfAborted();
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
		if (Object.hasOwn(options, "expectedState")) {
			const currentState = await fileState(args.path);
			if (JSON.stringify(currentState) !== JSON.stringify(options.expectedState)) throw new Error(`${args.path} changed during investigation; no generated content was written. Read current state and retry.`);
			if (currentState && !sameVersion(previousEntry, await lstat(target))) throw new Error("The target changed before writing.");
		}
		await writeAtomically(target, args.content, previousEntry, options.signal);
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
		if (!await isWithinResolvedRoot(await realpath(dirname(target)))) throw new Error("Parent directory resolved outside the current workspace.");
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
		if (!await isWithinResolvedRoot(await realpath(target))) throw new Error("Directory resolved outside the current workspace.");
		const current = await lstat(target);
		if (!current.isDirectory() || !sameFile(entry, current)) throw new Error("The directory changed before it could be deleted.");
		await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
		return `Deleted directory ${args.path} and its contents.`;
	}

	// Local paths for @ autocomplete; never added to model context.
	async function listFiles() {
		const filePaths = [];
		let visitedEntries = 0;
		async function appendDirectory(directoryPath) {
			if (visitedEntries >= MAX_AUTOCOMPLETE_ENTRIES) return;
			let entries;
			try {
				await assertPath(directoryPath);
				entries = await readdir(directoryPath, { withFileTypes: true });
			} catch {
				return;
			}
			entries = entries.filter((entry) => !(entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())));
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				if (visitedEntries >= MAX_AUTOCOMPLETE_ENTRIES) break;
				visitedEntries += 1;
				const childPath = join(directoryPath, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					await appendDirectory(childPath);
				} else if (entry.isFile()) {
					filePaths.push(relativeName(childPath));
				}
			}
		}
		await appendDirectory(rootDirectory);
		return filePaths.sort((left, right) => left.localeCompare(right));
	}

	async function readProjectGuidance() {
		let guidance = "";
		try {
			const target = join(rootDirectory, "AGENTS.md");
			await assertPath(target);
			const entry = await lstat(target);
			if (!entry.isFile() || entry.nlink > 1) {
				guidance = "## AGENTS.md project guidance\nAGENTS.md is not a regular unlinked file and could not be loaded.";
			} else if (entry.size > MAX_AGENTS_BYTES) {
				guidance = `## AGENTS.md project guidance\nAGENTS.md exceeds the ${MAX_AGENTS_BYTES} byte limit.`;
			} else {
				const { buffer } = await readRegularBuffer(target, "AGENTS.md");
				if (buffer.length > MAX_AGENTS_BYTES) throw new Error("AGENTS.md grew beyond its size limit.");
				const agentsContent = decodeText(buffer, "AGENTS.md");
				guidance = `## AGENTS.md project guidance (reloaded before each model request)\n${agentsContent}`;
			}
		} catch (error) {
			if (error?.code !== "ENOENT") guidance = `## AGENTS.md project guidance\nCould not load AGENTS.md: ${error?.code || error.message}`;
		}
		return guidance;
	}

	const workspace = {
		rootDirectory,
		resolvePath,
		listDirectory: listDirectoryTool,
		readFile: readFileTool,
		readFileDetailed: (args, options = {}) => readFileTool(args, { ...options, detailed: true }),
		readRawFile,
		fileState,
		editFile: editFileTool,
		writeFile: writeFileTool,
		deleteFile: deleteFileTool,
		deleteDirectory: deleteDirectoryTool,
		listFiles,
		readProjectGuidance,
	};
	workspace.searchFiles = (args, options) => searchWorkspace(workspace, args, options);
	return workspace;
}
