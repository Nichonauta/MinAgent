# MinAgent

MinAgent is a small terminal coding agent for the directory from which it is started. It connects to an OpenAI Chat Completions compatible endpoint, streams the model response as it arrives, and gives the model workspace tools for reading and changing files.

The project has no package manager or runtime dependencies. It runs directly with Node.js.

## Requirements

- Node.js 22 or later.
- An OpenAI Chat Completions compatible server with SSE streaming.
- Tool calling is required for workspace file operations. Multimodal input is required only when using images.

## Configuration

MinAgent reads `.env` from the MinAgent installation directory. Values already present in the operating-system environment take precedence over that file.

Example configuration for a local llama.cpp server:

```env
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPENAI_API_KEY=llama.cpp
OPENAI_MODEL=llama.cpp
OPENAI_INPUT=text,image
OPENAI_CONTEXT_WINDOW=262144
OPENAI_SHOW_REASONING=off
WORKSPACE_LIST_LIMIT=0
TERMINAL_MODE=off
SKILLS_ENABLED=off
MCP_ENABLED=off
```

`OPENAI_MODEL` is required. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` and is normalized to the `/chat/completions` endpoint. `OPENAI_API_KEY` is optional. Each request can remain active for up to one hour before timing out.

Boolean settings use only `on` and `off`:

- `OPENAI_SHOW_REASONING=on` displays the reasoning channel as muted gray text while it streams. `off` keeps the regular `Processing...` indicator. The endpoint must send `choices[0].delta.reasoning_content` (llama.cpp) or `choices[0].delta.reasoning_summary`.
- `SKILLS_ENABLED=on` loads local skills. The default is `off`.
- `MCP_ENABLED=on` loads configured MCP servers. The default is `off`.

For llama.cpp, use `--reasoning-format deepseek` when the model template does not automatically emit a separate `reasoning_content` channel. MinAgent displays that channel as progress text and keeps the final answer in its normal response presentation.

`OPENAI_INPUT` must contain `text` and may also contain `image`. `OPENAI_CONTEXT_WINDOW` is a positive integer and defaults to `262144` tokens; set it to the actual model context limit. `WORKSPACE_LIST_LIMIT` defaults to `0`, which disables recursive inventory and `@` file suggestions. The model can still call `list_directory` for a focused listing. A positive value includes up to that many entries per directory; `-1` includes all entries. Inventories exclude common generated directories and stop at 10,000 entries or 128 KiB of text. `/init` builds a one-time inventory regardless of this setting. `TERMINAL_MODE` accepts lowercase `auto`, `ask`, or `off`, and defaults to `ask` when it is not set.

## Starting MinAgent

Start it from the workspace directory that the agent is allowed to modify:

PowerShell:

```powershell
Set-Location "C:\path\to\your\project"
& "C:\path\to\MinAgent\minagent.ps1"
```

CMD:

```bat
cd /d C:\path\to\your\project
C:\path\to\MinAgent\minagent.cmd
```

It can also be started directly:

```powershell
node "C:\path\to\MinAgent\src\minagent.mjs"
```

The workspace is the directory where the command is launched. File tools and image attachments accept paths inside it only. Terminal commands and configured MCP servers run with the user's account permissions.

File tool paths are relative to that directory. If MinAgent is started in `Test`, use `README.md` for `Test/README.md`. A redundant `Test/README.md` also resolves to the root file when there is no real `Test` subdirectory; if one exists, its paths take precedence. Use `./Test/file.txt` to explicitly target or create a same-named subdirectory. Without such a subdirectory, `Test` alone refers to the workspace root and cannot be read as a file or deleted.

## Conversation and streaming

The final answer streams into a shaded assistant response as tokens arrive. Markdown headings, lists, code fences, links, inline formatting, and tables are rendered for the terminal. Tables are aligned to the terminal width and long cell contents wrap across lines.

When `OPENAI_SHOW_REASONING=on` and the endpoint supplies a supported reasoning delta, the reasoning is printed before the final response as muted gray text without a separate panel or background. If the endpoint does not supply that field, MinAgent continues to show `Processing...` and the final response normally.

The model chooses when it needs workspace contents. With `WORKSPACE_LIST_LIMIT=0`, no recursive inventory is injected and `@` file autocomplete is disabled; the model can call `list_directory` to inspect a specific directory's immediate entries. Otherwise, the inventory supplies paths but no file contents. MinAgent does not force an initial `read_file` call merely because files exist. When a request depends on project files, the model should call `read_file` before planning, diagnosing, or changing them. `list_directory` includes hidden entries, does not recurse, and returns at most 500 entries by default. After an edit or write, it must read the result back; a failed edit requires rereading the same file before retrying.

MinAgent verifies successful writes itself and keeps required model readbacks pending across failed turns. `/new` resets that pending state and reports any paths that were left unverified. A model response may request at most 16 tool calls; a turn may use at most 32 tool rounds.

When enabled, the inventory is refreshed before each model request. If the workspace root contains `AGENTS.md`, its content is reloaded before each request and included as project guidance up to 64 KiB, whether or not the inventory is enabled.

## Input, multiline text, and file attachments

Press `Ctrl+J` to insert a newline without sending the message. Multiline text pasted into the prompt keeps its line breaks and does not submit one request per line. Press Enter to send.

Type `@` followed by a filename fragment to search workspace files. Use ↑/↓ to select a result and Enter to replace the fragment with its complete path in the current line; press Enter again to submit. Selecting a text file attaches an excerpt of up to 48 KiB. Selecting an image attaches it as multimodal input. Up to eight files and four images can be attached to one message; each file is limited to 10 MiB.

Image paths written directly in a message are detected for PNG, JPEG, GIF, and WebP files inside the workspace. MinAgent attaches the image data and removes the path from the text sent to the model. The model endpoint must support image input.

Set `NO_COLOR` to disable terminal colors.

## Commands

Type `/` to open command autocomplete. Use ↑/↓ to choose a command and Enter to complete it in the current line; press Enter again to run it. The available commands are:

- `/context`: show approximate token counts for system sections, available tool schemas, and conversation history, plus the latest endpoint-reported `prompt_tokens` when available.
- `/compact [instructions]`: summarize older conversation history and keep the recent messages.
- `/init [focus]`: inspect a one-time workspace inventory and selected project files, show which files were selected, and create or update the workspace root `AGENTS.md`. It reads up to 24 files, with excerpt and total-size limits.
- `/new`: clear the screen and start a new conversation.
- `/exit`: close MinAgent.

Compaction also runs automatically as the configured context window fills. The summary preserves file paths, decisions, unresolved work, user preferences, and verification state.

## Workspace tools

The model can use these built-in tools within the workspace root:

- `read_file`: read a UTF-8 text file, or a supported image when image input is enabled. Text output is limited to 300 lines and 48 KiB. For a long line, use the returned `offset` and `column` to continue within that line.
- `list_directory`: list immediate files and subdirectories, including hidden entries, without recursion. It defaults to the workspace root and 500 entries; pass a workspace-relative `path` or a larger `limit` when needed. Output is capped at 50 KiB and 10,000 entries; symbolic links are shown but never followed.
- `edit_file`: replace one exact, unique text block in an existing file.
- `write_file`: create or atomically replace a UTF-8 file and its missing parent directories.
- `delete_file`: delete one regular file.
- `delete_directory`: recursively delete a regular subdirectory after validating its contents.
- `run_terminal`: available only when `TERMINAL_MODE` is `auto` or `ask`. It runs in the workspace directory; `ask` requires approval for each command.

Read, edit, write, and delete operations check for symbolic links, junctions, hard-linked files, special files, and paths outside the workspace. They also check file identity and changes around reads and replacements. Individual reads and writes are limited to 10 MiB. The workspace root cannot be deleted. A successful edit or write is reread and compared with the requested content before the tool reports success. As with other path-based Node.js file operations, an untrusted process that concurrently swaps parent directories can still race a rename or deletion; use a workspace directory tree that other untrusted processes cannot modify.

## Skills

When `SKILLS_ENABLED=on`, MinAgent discovers `SKILL.md` files in these directories:

- MinAgent `skills/<skill-name>/`
- MinAgent `.agents/skills/<skill-name>/`
- Workspace `skills/<skill-name>/`
- Workspace `.agents/skills/<skill-name>/`

Each manifest requires YAML frontmatter with `name` and `description`. The first 24 valid skills are loaded. A manifest is limited to 96 KiB, a supporting resource to 64 KiB, and skill guidance in the model context to 32 KiB. Skills are disabled by default.

## MCP servers

When `MCP_ENABLED=on`, MinAgent reads `.minagent/mcp.json` from the MinAgent installation directory. The file must contain an `mcpServers` object. Servers can use local stdio transport or Streamable HTTP:

```json
{
  "mcpServers": {
    "project-tools": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-server.mjs"],
      "cwd": "C:\\path\\to\\project"
    },
    "remote-tools": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {}
    }
  }
}
```

MinAgent discovers the server tools at startup and exposes them to the model. It supports up to 32 configured servers and 256 tools. MCP text results are limited to 96 KiB, and supported MCP images follow the same 10 MiB and four-image limits as local attachments. MCP servers run with the user's account permissions.

## Project layout

- `src/minagent.mjs`: TUI, conversation loop, tool dispatch, and commands.
- `src/attachments.mjs` and `src/image.mjs`: file attachments and image handling.
- `src/markdown-terminal.mjs` and `src/terminal-text.mjs`: streaming Markdown and terminal text layout.
- `src/terminal-command.mjs` and `src/processes.mjs`: terminal execution and process cleanup.
- `src/tool-state.mjs`: pending file readback and edit-recovery state.
- `src/openai.mjs`: OpenAI-compatible SSE client, one-hour timeout, tool-call reassembly, and reasoning deltas.
- `src/config.mjs`: `.env` loading and configuration validation.
- `src/workspace.mjs`: workspace boundaries and file operations.
- `src/editor.mjs`: multiline editing, paste handling, and autocomplete.
- `src/readline-adapter.mjs`: isolated access to Node's interactive readline state.
- `src/context.mjs`: token estimation, conversation serialization, and compaction.
- `src/skills.mjs`: local skill discovery and skill tools.
- `src/mcp.mjs`: MCP configuration, transports, tool discovery, and result handling.
- `src/init-project.mjs`: project file selection for `/init`.
- `minagent.cmd` and `minagent.ps1`: Windows launchers.

## Tests

Run `node --test` from the MinAgent directory. The tests use Node.js built-ins and cover workspace files, attachments, context chunking, streaming responses, terminal approval, and a local MCP HTTP server.

## License and notice

MinAgent's own code is licensed under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md) for the Pi attribution. The project is a standalone implementation inspired by the Pi agent harness; it does not include Pi source files.
