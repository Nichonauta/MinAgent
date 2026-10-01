// Shared traversal policy for file autocomplete, searches, and /init investigation.
export const EXCLUDED_DIRECTORIES = new Set([
	".git", ".hg", ".svn", "node_modules", ".next", ".cache", "dist", "build", "coverage",
]);
