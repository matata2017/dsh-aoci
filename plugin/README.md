# @local/dsh-aoci

DeepSeek Harness integration for [AOCI-CODE](https://github.com/aoci-spec/aoci-code).

It exposes AOCI-CODE through four surfaces:

- **MCP** — the nine `aoci_*` tools (`aoci_rules`, `aoci_overview`, `aoci_get_entries`, `aoci_search`, `aoci_maintain`, `aoci_update_entry`, `aoci_remove_entry`, `aoci_header`, `aoci_report`) as `mcp__aoci__*` through the host MCP manager.
- **CLI tool** — an `aoci` tool for setup and maintenance commands (`init`, `scan`, `status`, `verify`, `check`, `doctor`, `index`, `ui`, …).
- **Pre-write hook** — before a write/edit tool runs, `aoci hook pretool` checks whether the target entry is stale. Blocking results are returned as a DSH tool denial; non-blocking reminders are injected into the next step.
- **Compaction hook** — after a DSH compaction, `aoci hook codex-compact` is injected as a context message so the next model request receives the AOCI refresh handoff.

## Install

```bash
plugin_manager install_bundle "D:/work/huanghao/aoci-code/plugin"
```

Edit the plugin's `config` in `cordis.patch.yml` or in the Plugins page. A single `repoRoot` keeps the existing `mcp__aoci__*` tools. To switch between projects within one session, configure `projects`:

```yaml
projects:
  - projectId: loan-information-boot
    repoRoot: 'E:/work/huanghao/loan-information-boot'
  - projectId: pinrong-online
    repoRoot: 'E:/work/huanghao/pinrong-online'
```

1. Call `aoci_project` with `{}` to list projects, or with `{"projectId":"pinrong-online"}` to select one in the current session. Selection resets when the plugin reloads.
2. Use `aoci` for status, checks, and `update-entry --preview`. The plugin supplies `--repo` for the selected project.
3. Use the selected MCP prefix for AOCI reads and writes, for example `mcp__aoci_pinrong_online__aoci_maintain` followed by `mcp__aoci_pinrong_online__aoci_update_entry`. Finish the current batch before switching. Start a new AOCI flow on the next project and keep cursors, receipts, and batches with their original project.

Each project has its own MCP process and index. Roots must be absolute and distinct. Optional `serverKey` overrides must use the `aoci_` prefix, lowercase letters, digits and single underscores, with a maximum length of 32 characters. Projects missing `.aoci/`, `aoci.txt`, `aoci.meta.txt` or `aoci.code.txt` appear in the list without an MCP prefix. Reload after initializing such a repository.

## Verify

```text
aoci status
```

or call `mcp__aoci__aoci_header` / `mcp__aoci__aoci_rules` in a DSH session.

## Notes

AOCI-CODE is Fair Source/source-available software under FSL-1.1-MIT; the bundled `bin/aoci.exe` was built from the canonical source at the version recorded in `bin/BUILD.txt`.
