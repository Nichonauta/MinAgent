export function createFileChangeTracker(platform = process.platform, resolveWorkspacePath) {
	const pendingReads = new Map();
	const normalize = (path) => {
		if (typeof path !== "string") return "";
		let canonicalPath = path;
		if (resolveWorkspacePath) {
			try {
				canonicalPath = resolveWorkspacePath(path);
			} catch {
				// Invalid paths still need a stable key until the tool reports the error.
			}
		}
		const normalized = canonicalPath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
		return platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	return {
		requiredPaths: () => [...pendingReads.values()],
		hasPending: () => pendingReads.size > 0,
		clear() {
			const paths = [...pendingReads.values()];
			pendingReads.clear();
			return paths;
		},
		requireRead(path) {
			const key = normalize(path);
			if (key) pendingReads.set(key, path);
		},
		completeRead(path, succeeded) {
			const key = normalize(path);
			if (succeeded && key) pendingReads.delete(key);
		},
		recordToolResult(name, args, { failed = false, mayHaveChanged = false } = {}) {
			const path = args?.path;
			if (typeof path !== "string" || !path) return;
			if (name === "read_file") this.completeRead(path, !failed);
			if (name === "edit_file" || name === "write_file") {
				if (!failed || mayHaveChanged || name === "edit_file") this.requireRead(path);
			}
		},
		assertRequiredCalls(calls, parseArguments) {
			const paths = this.requiredPaths();
			if (paths.length === 0) return;
			if (calls.length !== paths.length || calls.some((call) => call?.function?.name !== "read_file")) {
				throw new Error(`The endpoint did not honor required read_file calls for ${paths.join(", ")}.`);
			}
			const expected = new Set(paths.map(normalize));
			const requested = new Set();
			for (const call of calls) {
				const args = parseArguments(call);
				const path = normalize(args.path);
				if (!expected.has(path) || requested.has(path)) {
					throw new Error(`Required read_file calls must reread each changed path exactly once: ${paths.join(", ")}.`);
				}
				requested.add(path);
			}
		},
	};
}
