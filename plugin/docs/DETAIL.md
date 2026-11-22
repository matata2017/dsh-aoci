# AOCI-CODE for DSH

This bundle is a host + configuration integration for AOCI-CODE.

## What is registered

| Row | Purpose |
| --- | --- |
| `aoci` host plugin (`@local/dsh-aoci`) | `aoci` CLI tool; `tools/pre-execute` hook; `session/event` compaction hook; MCP server registration |
| `aoci` MCP server (registered by the host plugin) | stdio `aoci --repo <repoRoot> mcp`, exposing the nine AOCI tools as `mcp__aoci__*` |

The MCP registration is performed through `ctx.mcpManager.register()` at plugin
startup, so changing `repoRoot` in the plugin config and reloading the plugin
reconnects the server against the new repository.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `repoRoot` | `D:/aoci-code` | Repository that AOCI governs. |
| `enableMcp` | `true` | Register the stdio MCP server. |
| `enableHooks` | `true` | Install pre-write and compaction hooks. |
| `aociPath` | bundled `bin/aoci.exe` | Override the AOCI binary path. |

## Hook behavior

- **Pre-write**: for tool names matching `edit`/`write`/`patch`/`create`/`delete`/`remove`/`move`/`rename`/`replace`, the plugin calls `aoci hook pretool` with the target path. Exit code 2 or 4 denies the write; successful reminders are injected as `aoci-hook` context.
- **Compaction**: after a compaction event, `aoci hook codex-compact` output is injected as `aoci-hook` context for the next model request.

Hooks never block on their own environment failures; they log a warning and allow the tool call.
