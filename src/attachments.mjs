import { detectImageMimeType, imageContentPart } from "./image.mjs";
import { MAX_READ_BYTES, MAX_READ_OUTPUT_BYTES } from "./workspace.mjs";

const MAX_ATTACHED_IMAGES = 4;
const MAX_ATTACHED_FILES = 8;
const IMAGE_PATH_PATTERN = /"([^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|'([^'\r\n]+?\.(?:png|jpe?g|gif|webp))'|((?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n"'<>]*?\.(?:png|jpe?g|gif|webp)\b|(?:\.{1,2}[\\/])?[^\s"'<>]+\.(?:png|jpe?g|gif|webp)\b)/gi;

function escapeXmlAttribute(value) {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

export async function prepareUserMessage(input, selectedFileReferences, { workspaceAccess, inputModalities }) {
	const images = [];
	const replacements = [];
	const events = [];
	const removeImageReference = (start, end) => {
		let mergedStart = start;
		let mergedEnd = end;
		for (let index = replacements.length - 1; index >= 0; index -= 1) {
			const replacement = replacements[index];
			if (mergedStart >= replacement.end || mergedEnd <= replacement.start) continue;
			mergedStart = Math.min(mergedStart, replacement.start);
			mergedEnd = Math.max(mergedEnd, replacement.end);
			replacements.splice(index, 1);
		}
		replacements.push({ start: mergedStart, end: mergedEnd });
	};
	const textAttachments = [];
	const seenPaths = new Set();
	let attachedFileCount = 0;

	for (const relativePath of selectedFileReferences) {
		if (attachedFileCount >= MAX_ATTACHED_FILES) {
			events.push({ kind: "limit", message: `File attachment limit reached: ${MAX_ATTACHED_FILES} files.` });
			break;
		}
		if (!input.includes(relativePath)) continue;
		try {
			const target = workspaceAccess.resolvePath(relativePath);
			const pathKey = process.platform === "win32" ? target.toLowerCase() : target;
			if (seenPaths.has(pathKey)) continue;
			const buffer = await workspaceAccess.readRawFile(relativePath);
			if (buffer.length > MAX_READ_BYTES) throw new Error(`Exceeds the ${MAX_READ_BYTES} byte limit.`);
			const mimeType = detectImageMimeType(buffer);
			if (mimeType) {
				if (!inputModalities.includes("image")) throw new Error("The configured model does not accept images.");
				if (images.length >= MAX_ATTACHED_IMAGES) throw new Error(`The ${MAX_ATTACHED_IMAGES}-image limit was reached.`);
				images.push({ path: relativePath, mimeType, data: buffer.toString("base64") });
				let position = input.indexOf(relativePath);
				while (position >= 0) {
					removeImageReference(position, position + relativePath.length);
					position = input.indexOf(relativePath, position + relativePath.length);
				}
			} else {
				if (buffer.includes(0)) throw new Error("Binary files cannot be attached as text.");
				const decoder = new TextDecoder("utf-8", { fatal: true });
				decoder.decode(buffer);
				let excerpt;
				for (let backoff = 0; backoff <= 3; backoff += 1) {
					try {
						excerpt = decoder.decode(buffer.subarray(0, Math.max(0, Math.min(buffer.length, MAX_READ_OUTPUT_BYTES) - backoff)));
						break;
					} catch {
						// A UTF-8 character can cross the excerpt boundary.
					}
				}
				if (excerpt === undefined) throw new Error("Could not decode the text attachment.");
				const truncated = buffer.length > MAX_READ_OUTPUT_BYTES;
				textAttachments.push(`<file name="${escapeXmlAttribute(relativePath)}">\n${excerpt}${truncated ? "\n[File content truncated; use read_file for more.]" : ""}\n</file>`);
			}
			seenPaths.add(pathKey);
			attachedFileCount += 1;
			events.push({ kind: "attached", path: relativePath });
		} catch (error) {
			events.push({ kind: "error", path: relativePath, message: error instanceof Error ? error.message : String(error) });
		}
	}

	for (const match of input.matchAll(IMAGE_PATH_PATTERN)) {
		if (images.length >= MAX_ATTACHED_IMAGES) break;
		const enteredPath = match[1] ?? match[2] ?? match[3];
		try {
			if (!inputModalities.includes("image")) throw new Error("OPENAI_INPUT does not include image.");
			const target = workspaceAccess.resolvePath(enteredPath);
			const pathKey = process.platform === "win32" ? target.toLowerCase() : target;
			if (seenPaths.has(pathKey)) {
				removeImageReference(match.index, match.index + match[0].length);
				continue;
			}
			const buffer = await workspaceAccess.readRawFile(enteredPath);
			const mimeType = detectImageMimeType(buffer);
			if (!mimeType) throw new Error("Unsupported format; use PNG, JPEG, GIF, or WebP.");
			images.push({ path: enteredPath, mimeType, data: buffer.toString("base64") });
			seenPaths.add(pathKey);
			removeImageReference(match.index, match.index + match[0].length);
			events.push({ kind: "attached", path: enteredPath });
		} catch (error) {
			events.push({ kind: "error", path: enteredPath, message: error instanceof Error ? error.message : String(error) });
		}
	}

	let text = input;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		text = text.slice(0, replacement.start) + text.slice(replacement.end);
	}
	const prompt = [text.trim(), ...textAttachments].filter(Boolean).join("\n\n") || "Analyze the attached image.";
	const message = images.length === 0 && textAttachments.length === 0
		? { role: "user", content: input }
		: { role: "user", content: [{ type: "text", text: prompt }, ...images.map(imageContentPart)] };
	return { message, events };
}
