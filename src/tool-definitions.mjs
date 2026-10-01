import { searchTool } from "./search.mjs";

export const workspaceTools = [
	searchTool,
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read workspace files or explicitly user-named outside files; outside directories cannot be listed.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					offset: { type: "integer", minimum: 1, description: "1-based first line" },
					limit: { type: "integer", minimum: 1, description: "Maximum returned lines" },
					column: { type: "integer", minimum: 1, description: "1-based column; follow continuation for long lines" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_directory",
			description: "List immediate workspace entries (including hidden; root by default). Never follow links; raise limit if truncated.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					limit: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum entries; default: 500" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "edit_file",
			description: "Replace one unique, exact block in a workspace file.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					old_text: { type: "string", description: "Exact text to replace" },
					new_text: { type: "string" },
				},
				required: ["path", "old_text", "new_text"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Create or replace a workspace file.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "delete_file",
			description: "Delete one regular file inside the workspace.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "delete_directory",
			description: "Recursively delete a workspace subdirectory; linked/special entries are blocked.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
			},
		},
	},
];
