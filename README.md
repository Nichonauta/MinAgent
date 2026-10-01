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
TERMINAL_MODE=off
SKILLS_MODE=off
MCP_MODE=off
```

`OPENAI_MODEL` is required. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` and is normalized to the `/chat/completions` endpoint. `OPENAI_API_KEY` is optional. Each request can remain active for up to one hour before timing out.

`TERMINAL_MODE`, `SKILLS_MODE`, and `MCP_MODE` accept lowercase `auto`, `ask`, or `off`:

| Mode | Behavior |
| --- | --- |
| `auto` | Execute without asking for approval. |
| `ask` | Request approval for each terminal command, skill instructions/resource load, or MCP tool call. |
| `off` | Disable the feature and omit its tools from the model's catalog. |

Terminal permissions default to `ask`; skills and MCP default to `off`. Skills and MCP are discovered at startup in `auto` and `ask`. Approval applies to using their tools.

For llama.cpp, use `--reasoning-format deepseek` when the model template does not automatically emit a separate `reasoning_content` channel. MinAgent displays that channel as progress text and keeps the final answer in its normal response presentation.

`OPENAI_INPUT` must contain `text` and may also contain `image`. `OPENAI_CONTEXT_WINDOW` is a positive integer and defaults to `262144` tokens; set it to the actual model context limit. `@` file autocomplete builds a local index when used, bounded to 10,000 entries and excluding common generated directories. This index is not sent to the model. The model can call `list_directory` for a focused listing, and `/init` investigates through directory listings and file reads.

## Context and tool execution

MinAgent uses the full `OPENAI_CONTEXT_WINDOW`, 300-line default reads capped at 48 KiB with continuation, 100 default search results, and up to 16 tool calls per response. Multiple changes can be requested in one response. Long non-file outputs retain their beginning and end within a 64,000-character budget, with omissions marked. The modes are Build and Plan.

Set `OPENAI_CONTEXT_WINDOW` to the server's actual context limit. Automatic compaction reserves up to 16,384 tokens for output, bounded to one quarter of that window, and retains about 20,000 recent-history tokens, also bounded to one quarter. Showing reasoning changes its display, not the server's thinking configuration.

Before editing an existing file, the agent requires evidence of the current exact block from `read_file`. Complete replacement requires a complete read, including consecutive partial reads. New files can be created directly. Successful writes update evidence; external changes or executed terminal/MCP calls invalidate it. Terminal commands still follow `TERMINAL_MODE` and can modify files independently of file-tool evidence checks.

Tool messages include status, read ranges, total lines, continuation, command exit status and uncertain changes. Invalid streamed calls get at most two correction attempts without executing incomplete requests. Batches exceeding 16 calls are rejected in full. Repeated failures and unchanged results are detected; persisted file contents are verified, but this does not mean application behavior was tested.

When enabled, MCP exposes the discovered tool schemas and server guidance in Build. Calls follow `MCP_MODE`. Evidence is bounded to 64 files and two million characters; evicted evidence must be read again. Under context pressure, older inspection bodies are removed while result metadata and tool-call pairing remain; compacted results retain both the beginning and end. Current task evidence survives conversation compacting and is cleared by `/new`.

### Reproducible model evaluation

`node scripts/evaluate.mjs --live` runs five isolated temporary fixtures against the configured API: targeted editing, read continuation, Plan boundaries, recovery after an external edit, and `/init`. It sends actual API requests; JSON output reports the model, task success, invalid/repeated calls, evidence failures, mode violations, elapsed time and tokens. Provider token usage is distinguished from estimates. A forbidden Plan attempt is reported even if the controller blocks it and the file remains unchanged.

Keep the model and quantization fixed when comparing runs. These fixtures measure specific outcomes, not every possible false claim or overall model quality. No live evaluation is performed by the ordinary unit tests.

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

The workspace is the directory where the command is launched. `list_directory`, file changes, and files selected through `@` are confined to it. `read_file` and an image path explicitly written in the prompt can read one specifically named file outside it, but cannot list outside directories. Terminal commands and configured MCP servers run with the user's account permissions.

File paths are relative to that directory. To read a file outside it, pass its explicit absolute path or a relative path such as `../notes.txt` to `read_file`; outside directories cannot be listed and other file tools cannot change them. If MinAgent is started in `Test`, use `README.md` for `Test/README.md`. A redundant `Test/README.md` also resolves to the root file when there is no real `Test` subdirectory; if one exists, its paths take precedence. Use `./Test/file.txt` to explicitly target or create a same-named subdirectory. Without such a subdirectory, `Test` alone refers to the workspace root and cannot be read as a file or deleted.

## Conversation and streaming

The final answer streams into a shaded assistant response as tokens arrive. Press `Esc` while a model response or compaction summary is streaming to stop that request; MinAgent returns to the prompt so you can send a correction. A partial answer is kept in the conversation when available. Markdown headings, lists, code fences, links, inline formatting, and tables are rendered for the terminal. Tables are aligned to the terminal width and long cell contents wrap across lines.

Chat bubbles wrap at word boundaries. Streaming holds the current word until a space, newline, or response end reveals its full width; words that do not fit move to the next line. Only words wider than the entire bubble are split. Stopping a response flushes its pending word.

When the endpoint supplies a supported reasoning delta, MinAgent always displays it in muted gray text as it streams, before the final answer. If the endpoint does not supply a reasoning delta, MinAgent shows `Processing...` until the final answer arrives.

The model chooses when it needs workspace contents and can call `list_directory` to inspect a specific directory's immediate entries. MinAgent does not send an automatic directory listing or force an initial `read_file` call merely because files exist. When a request depends on project files, the model should call `read_file` before planning, diagnosing, or changing them. `list_directory` includes hidden entries, does not recurse, and returns at most 500 entries by default. Successful edits and writes are verified internally by MinAgent; the model does not need to read the same file back. After a failed edit, reread the file before retrying so the new edit is based on its current contents.

MinAgent verifies the persisted contents before a successful edit or write tool reports completion. A model response may request at most 16 tool calls; a turn may use at most 32 tool rounds.

If the workspace root contains `AGENTS.md`, its content is reloaded before each request and included as project guidance up to 64 KiB.

## Build and Plan modes

MinAgent starts in **Build**, with the configured workspace tools, terminal permissions, skills, and MCP tools. Press **Tab** (or Shift+Tab) to alternate between Build and **Plan** without changing your draft. The input label shows `Build ›` in green or `Plan ›` in amber; `Tab mode` appears in the shortcuts.

Plan can only call `list_directory`, `read_file`, and `search_files`. It inspects relevant files and answers questions or proposes changes in the chat. Editing, writing, deletion, terminal commands, skills, and MCP calls are blocked before execution, including tools requested outside the advertised catalog. `/init` is also blocked because it writes `AGENTS.md`. Session commands such as `/model`, `/compact`, `/new`, and `/exit` remain available.

Each submitted message keeps its selected mode, including queued messages. Tab during a response selects the mode for the next message; the current response continues with its original permissions. When these modes differ, the bar also shows `Running: Build` or `Running: Plan`. Model selectors and approval prompts retain keyboard priority. Tabs within pasted text remain text.

Both modes share the conversation. Changing to Build does not start implementation automatically; send your implementation request. Plan-specific instructions and tool schemas are replaced when the active mode changes, rather than appended to conversation history.

Plan describes steps, affected files, interfaces, and expected behavior. Its instructions exclude complete implementations, replacement files, and full patches; brief pseudocode or minimal snippets are reserved for explaining a decision.

Application instructions live in `src/prompts.mjs`: shared rules, Build/Plan, compaction, `/init`, and extension guidance. Compaction sends its instructions once in the system message and keeps transcript, previous checkpoint, and user focus in the data message. Project guidance and external skill/MCP content retain their existing contents and size limits.

## Input, multiline text, and file attachments

Press `Ctrl+J` to insert a newline without sending the message. Multiline text pasted into the prompt keeps its line breaks and does not submit one request per line. Press Enter to send.

Use `↑` and `↓` to move between visible rows of a multiline message, including rows wrapped by the terminal width. The cursor preserves its preferred column across shorter lines. With autocomplete open, these keys select suggestions; with a single-row message, they navigate history.

Type `@` followed by a filename fragment to search workspace files. Use ↑/↓ to select a result and Enter to replace the fragment with its complete path in the current line; press Enter again to submit. Selecting a text file attaches an excerpt of up to 48 KiB. Selecting an image attaches it as multimodal input. Up to eight files and four images can be attached to one message; each file is limited to 10 MiB.

Image paths written directly in a message are detected for PNG, JPEG, GIF, and WebP files inside or outside the workspace. Outside images must be named explicitly; MinAgent does not list outside directories. It attaches the image data and removes the path from the text sent to the model. The model endpoint must support image input.

Set `NO_COLOR` to disable terminal colors.

## Commands

Type `/` to open command autocomplete. Use ↑/↓ to choose a command and Enter to complete it in the current line; press Enter again to run it. The available commands are:

- `/new`: clear the screen and start a new conversation.
- `/init [focus]`: list the root, read existing `AGENTS.md`, and let the model investigate important files using only listing, searching, and reading tools. Each attempt and result is shown, including read ranges, continuations, and errors. After evidence checks, generate and save the root `AGENTS.md`. Root documentation/manifests/configuration must be inspected when present; relevant project subdirectories and discovered source code require exploration. Investigation is limited to 16 rounds, 16 calls per response, and 60% of the configured context estimate. Insufficient evidence, cancellation, invalid output, or concurrent changes to `AGENTS.md` prevent saving. Empty repositories receive a minimal guide. Esc cancels investigation or generation; `/init` remains unavailable in Plan.
- `/model`: query the current API's `/models` catalog and open a selector. Use ↑/↓ to choose, Enter to switch, or Esc to close. `/model identifier` switches directly to an identifier in that catalog. Changes apply for this session and preserve the conversation; commands entered during a response wait their turn in the queue. Esc also cancels a pending catalog request.
- `/compact [instructions]`: summarize history older than the recent ~20,000-token window. Compaction cuts only at safe user or completed assistant-message boundaries, so a large completed tool round can be summarized as a unit.
- `/exit`: close MinAgent.

Model catalogs do not guarantee support for chat, tools, or images. When provided, positive `context_window`/`context_length` and `input_modalities` (or `architecture.input_modalities`) update the session settings. Otherwise, the original configured context size and input capabilities apply, and MinAgent reports that fallback. A declared text-only model cannot receive a conversation containing images; start with `/new` before switching. `OPENAI_MODEL` still determines the next session's initial model.

Compaction also runs automatically as the configured context window fills. The summary preserves file paths, decisions, unresolved work, user preferences, and verification state. It reduces conversation history; the system prompt, workspace guidance, and tool schemas remain. `/compact` reports both history and total context before and after. Current context usage remains visible in the persistent status bar.

## Workspace tools

The model can use these built-in tools; directory listings and file changes stay within the workspace root:

- `read_file`: read a specifically named UTF-8 text file inside or outside the workspace, or a supported image when image input is enabled. It cannot list directories. Text output is limited to 300 lines and 48 KiB. For a long line, use the returned `offset` and `column` to continue within that line.
- `list_directory`: list immediate files and subdirectories, including hidden entries, without recursion. It defaults to the workspace root and 500 entries; pass a workspace-relative `path` or a larger `limit` when needed. Output is capped at 50 KiB and 10,000 entries; symbolic links are shown but never followed.
- `search_files`: recursively search a literal, non-empty single-line `query` in filenames, UTF-8 content, or both (`mode`: `filename`, `content`, `both`; default: `both`). `path` selects a workspace directory; `case_sensitive` defaults to false. Content results include a 1-based line/Unicode character column and a redacted snippet; one matching line counts as one result. Results distinguish filename hits from content hits. Searches exclude common generated directories, skip links and binary/invalid text, and report omissions/errors. Limits: 100 results by default (maximum 500), 48 KiB output, 10,000 entries, 10 MiB per file, 64 MiB total reads, and 15 seconds. Esc stops an active search and preserves partial results with a canceled status. Narrow the path/query when results are incomplete; use `read_file` for full context. `/init` may search to locate sources, but results do not satisfy its required file reads.
- `edit_file`: replace one exact, unique text block in an existing file.
- `write_file`: create or atomically replace a UTF-8 file and its missing parent directories.
- `delete_file`: delete one regular file.
- `delete_directory`: recursively delete a regular subdirectory after validating its contents.
- `run_terminal`: available only when `TERMINAL_MODE` is `auto` or `ask`. It runs in the workspace directory; `ask` requires approval for each command.

Reads check file identity and changes around opening and reading. `read_file` can read only a specifically named outside file; outside directories cannot be discovered through `list_directory`, and edit, write, and delete tools remain confined to the workspace. Within the workspace, file operations check for symbolic links, junctions, hard-linked files, special files, and paths outside the workspace. Individual reads and writes are limited to 10 MiB. The workspace root cannot be deleted. A successful edit or write is reread and compared with the requested content before the tool reports success. As with other path-based Node.js file operations, an untrusted process that concurrently swaps parent directories can still race a rename or deletion; use a workspace directory tree that other untrusted processes cannot modify.

## Skills

When `SKILLS_MODE` is `auto` or `ask`, MinAgent discovers `SKILL.md` files in these directories:

- MinAgent `skills/<skill-name>/`
- MinAgent `.agents/skills/<skill-name>/`
- Workspace `skills/<skill-name>/`
- Workspace `.agents/skills/<skill-name>/`

Each manifest requires YAML frontmatter with `name` and `description`. The first 24 valid skills are discovered; catalog descriptions are shortened to 160 characters each and 8 KiB total. A skill file is limited to 64 KiB and a supporting resource to 32 KiB. The model uses one `load_skill` tool: omit `path` to load instructions, or set it to read a bundled resource. In `ask`, each load requires approval; in `auto`, it runs directly. `off` skips discovery and disables the tool. Skills are disabled by default.

## MCP servers

When `MCP_MODE` is `auto` or `ask`, MinAgent reads `.minagent/mcp.json` from the MinAgent installation directory. The file must contain an `mcpServers` object. Servers can use local stdio transport or Streamable HTTP:

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

MinAgent discovers server tools at startup and exposes up to 32 tools to the model. In `ask`, each call requires approval; in `auto`, it runs directly. `off` skips server connections and tool discovery. MCP is disabled by default. Each input schema is limited to 8 KiB, all exposed tool definitions together to 64 KiB, and combined server instructions to 8 KiB. MCP text results are limited to 48,000 characters; supported images follow the same 10 MiB and four-image limits as local attachments. MCP servers run with the user's account permissions.

## Project layout

- `src/minagent.mjs`: TUI, conversation loop, tool dispatch, and commands.
- `src/agent-mode.mjs`: Build/Plan permissions and mode state.
- `src/agent-runtime.mjs`: tool validation, edit evidence, result metadata, and loop guards.
- `src/attachments.mjs` and `src/image.mjs`: file attachments and image handling.
- `src/markdown-terminal.mjs` and `src/terminal-text.mjs`: streaming Markdown and terminal text layout.
- `src/terminal-command.mjs` and `src/processes.mjs`: terminal execution and process cleanup.
- `src/tool-permissions.mjs`: shared Auto/Ask/Off permissions for terminal commands, skills, and MCP.
- `src/openai.mjs`: OpenAI-compatible SSE client, one-hour timeout, tool-call reassembly, and reasoning deltas.
- `src/config.mjs`: `.env` loading and configuration validation.
- `src/workspace.mjs`: workspace boundaries and file operations.
- `src/workspace-policy.mjs`: shared generated-directory exclusions for file autocomplete, searches, and `/init`.
- `src/editor.mjs`: multiline editing, paste handling, and autocomplete.
- `src/commands.mjs`: shared slash-command catalog.
- `src/input-layout.mjs` and `src/terminal-footer.mjs`: visual input rows, cursor navigation, and the persistent status bar.
- `src/readline-adapter.mjs`: isolated access to Node's interactive readline state.
- `src/context.mjs`: token estimation, conversation serialization, and compaction.
- `src/skills.mjs`: local skill discovery and skill tools.
- `src/mcp.mjs`: MCP configuration, transports, tool discovery, and result handling.
- `src/init-project.mjs`: project file selection for `/init`.
- `src/search.mjs` and `src/tool-definitions.mjs`: literal workspace search and built-in tool schemas.
- `src/secrets.mjs`: secret redaction for previews and tool output.
- `src/evaluation.mjs` and `scripts/evaluate.mjs`: isolated model evaluation fixtures and the optional live runner.
- `minagent.cmd` and `minagent.ps1`: Windows launchers.

## Tests

Run `node --test` from the MinAgent directory. The tests use Node.js built-ins and cover workspace files, attachments, context chunking, streaming responses, terminal approval, and a local MCP HTTP server.

## License and notice

MinAgent's own code is licensed under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md) for the Pi attribution. The project is a standalone implementation inspired by the Pi agent harness; it does not include Pi source files.
