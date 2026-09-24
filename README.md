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
WORKSPACE_LIST_LIMIT=-1
TERMINAL_MODE=Off
SKILLS_ENABLED=off
MCP_ENABLED=off
```

`OPENAI_MODEL` is required. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1` and is normalized to the `/chat/completions` endpoint. `OPENAI_API_KEY` is optional. Each request can remain active for up to one hour before timing out.

Boolean settings use only `on` and `off`:

- `OPENAI_SHOW_REASONING=on` displays the reasoning channel as muted gray text while it streams. `off` keeps the regular `Processing...` indicator. The endpoint must send `choices[0].delta.reasoning_content` (llama.cpp) or `choices[0].delta.reasoning_summary`.
- `SKILLS_ENABLED=on` loads local skills. The default is `off`.
- `MCP_ENABLED=on` loads configured MCP servers. The default is `off`.

For llama.cpp, use `--reasoning-format deepseek` when the model template does not automatically emit a separate `reasoning_content` channel. MinAgent displays that channel as progress text and keeps the final answer in its normal response presentation.

`OPENAI_INPUT` must contain `text` and may also contain `image`. `OPENAI_CONTEXT_WINDOW` is a positive integer and defaults to `262144` tokens. `WORKSPACE_LIST_LIMIT` defaults to `-1`, which includes every inventory entry; a non-negative value limits the number of entries shown per directory. `TERMINAL_MODE` accepts `Auto`, `Ask`, or `Off`, and defaults to `Ask` when it is not set.

## Starting MinAgent

Start it from the workspace directory that the agent is allowed to modify:

PowerShell:

```powershell
Set-Location "C:\path\to\your\project"
& "C:\Users\Usuario\Documents\Desarrollo\MinAgent\minagent.ps1"
```

CMD:

```bat
cd /d C:\path\to\your\project
C:\Users\Usuario\Documents\Desarrollo\MinAgent\minagent.cmd
```

It can also be started directly:

```powershell
node "C:\Users\Usuario\Documents\Desarrollo\MinAgent\src\minagent.mjs"
```

The workspace is the directory where the command is launched. File tools cannot access paths outside it.

## Conversation and streaming

The final answer streams into a shaded assistant response as tokens arrive. Markdown headings, lists, code fences, links, inline formatting, and tables are rendered for the terminal. Tables are aligned to the terminal width and long cell contents wrap across lines.

When `OPENAI_SHOW_REASONING=on` and the endpoint supplies a supported reasoning delta, the reasoning is printed before the final response as muted gray text without a separate panel or background. If the endpoint does not supply that field, MinAgent continues to show `Processing...` and the final response normally.

The model chooses when it needs workspace contents. The workspace inventory provides paths, but MinAgent does not force an initial `read_file` call merely because files exist. When a request depends on project files, the model should call `read_file` before planning, diagnosing, or changing them. After an edit or write, it must read the result back; a failed edit requires rereading the same file before retrying.

The inventory is refreshed before each model request. If the workspace root contains `AGENTS.md`, it is reloaded before each request and included as project guidance. The inventory lists paths and entry types; it does not contain file contents.

## Input, multiline text, and file attachments

Press `Ctrl+J` to insert a newline without sending the message. Multiline text pasted into the prompt keeps its line breaks and does not submit one request per line. Press Enter to send.

Type `@` followed by a filename fragment to search workspace files. Use the arrow keys to select a result and Enter to insert it. Selecting a text file attaches an excerpt of up to 48 KiB. Selecting an image attaches it as multimodal input. Up to eight files and four images can be attached to one message; each file is limited to 10 MiB.

Image paths written directly in a message are detected for PNG, JPEG, GIF, and WebP files. MinAgent attaches the image data and removes the path from the text sent to the model, so the model does not try to read an external image path as if it were a workspace file. The model endpoint must support image input.

Set `NO_COLOR` to disable terminal colors.

## Commands

Type `/` to open command autocomplete. The available commands are:

- `/compact [instructions]`: summarize older conversation history and keep the recent messages.
- `/init [focus]`: inspect the most relevant project files and create or update the workspace root `AGENTS.md`.
- `/new`: clear the screen and start a new conversation.
- `/exit`: close MinAgent.

Compaction also runs automatically as the configured context window fills. The summary preserves file paths, decisions, unresolved work, user preferences, and verification state.

## Workspace tools

The model can use these built-in tools within the workspace root:

- `read_file`: read a UTF-8 text file, or a supported image when image input is enabled. Text output is limited to 300 lines and 48 KiB.
- `edit_file`: replace one exact, unique text block in an existing file.
- `write_file`: create or atomically replace a UTF-8 file and its missing parent directories.
- `delete_file`: delete one regular file.
- `delete_directory`: recursively delete a regular subdirectory after validating its contents.
- `run_terminal`: available only when `TERMINAL_MODE` is `Auto` or `Ask`. It runs in the workspace directory; `Ask` requires approval for each command.

Read, edit, write, and delete operations reject symbolic links, junctions, hard-linked files, special files, and paths outside the workspace. Individual reads and writes are limited to 10 MiB. The workspace root cannot be deleted.

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

- `src/minagent.mjs`: TUI, conversation loop, tool dispatch, rendering, commands, and attachments.
- `src/openai.mjs`: OpenAI-compatible SSE client, one-hour timeout, tool-call reassembly, and reasoning deltas.
- `src/config.mjs`: `.env` loading and configuration validation.
- `src/workspace.mjs`: workspace boundaries and file operations.
- `src/editor.mjs`: multiline editing, paste handling, and autocomplete.
- `src/context.mjs`: token estimation, conversation serialization, and compaction.
- `src/skills.mjs`: local skill discovery and skill tools.
- `src/mcp.mjs`: MCP configuration, transports, tool discovery, and result handling.
- `src/init-project.mjs`: project file selection for `/init`.
- `minagent.cmd` and `minagent.ps1`: Windows launchers.

## License and notice

See [NOTICE.md](NOTICE.md) for the attribution notice. The project is a standalone implementation inspired by the Pi agent harness; it does not include Pi source files.
