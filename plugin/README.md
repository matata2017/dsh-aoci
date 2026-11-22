# @local/dsh-aoci

DeepSeek Harness integration for [AOCI-CODE](https://github.com/aoci-spec/aoci-code).

It exposes AOCI-CODE through four surfaces:

- **MCP** — the nine `aoci_*` tools (`aoci_rules`, `aoci_overview`, `aoci_get_entries`, `aoci_search`, `aoci_maintain`, `aoci_update_entry`, `aoci_remove_entry`, `aoci_header`, `aoci_report`) as `mcp__aoci__*` through the host MCP manager.
- **CLI tool** — an `aoci` tool for setup and maintenance commands (`init`, `scan`, `status`, `verify`, `check`, `doctor`, `index`, `ui`, …).
- **Pre-write hook** — before a write/edit tool runs, `aoci hook pretool` checks whether the target entry is stale. Blocking results are returned as a DSH tool denial; non-blocking reminders are injected into the next step.
- **Compaction hook** — after a DSH compaction, `aoci hook codex-compact` is injected as a context message so the next model request receives the AOCI refresh handoff.

## Install

```bash
plugin_manager install_bundle "D:/aoci-dsh/plugin"
```

The default `repoRoot` is `D:/aoci-code`; edit `cordis.patch.yml` before installing, or change the `repoRoot` row config in the Plugins page, to point at your own repository.

The repository must be initialized for AOCI (`aoci init` and `aoci scan`, or pre-existing `aoci.txt` / `.aoci/`).

## Verify

```text
aoci status
```

or call `mcp__aoci__aoci_header` / `mcp__aoci__aoci_rules` in a DSH session.

## Notes

AOCI-CODE is Fair Source/source-available software under FSL-1.1-MIT; the bundled `bin/aoci.exe` was built from the canonical source at the version recorded in `bin/BUILD.txt`.
