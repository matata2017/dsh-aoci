# AOCI-CODE DSH 集成安装说明

## 前置

- DSH desktop profile 已运行
- `D:/aoci-code` 已初始化 AOCI（有 `aoci.txt` / `.aoci/`）；如果要管理其他仓库，先运行：

```bash
D:/aoci-dsh/bin/aoci.exe --repo <你的仓库> init --locale zh-CN --agent codex
D:/aoci-dsh/bin/aoci.exe --repo <你的仓库> scan
```

## 安装插件

在 DSH 中执行：

```text
plugin_manager install_bundle "D:/aoci-dsh/plugin"
```

如果要换仓库，安装前编辑 `plugin/cordis.patch.yml`：

```yaml
repoRoot: 'D:/你的仓库'
```

或者在 DSH 的 Plugins 页面编辑 `@local/dsh-aoci` 配置。

## 使用

- MCP 工具：`mcp__aoci__aoci_rules`、`mcp__aoci__aoci_overview`、
  `mcp__aoci__aoci_get_entries`、`mcp__aoci__aoci_search`、
  `mcp__aoci__aoci_maintain`、`mcp__aoci__aoci_update_entry`、
  `mcp__aoci__aoci_remove_entry`、`mcp__aoci__aoci_header`、
  `mcp__aoci__aoci_report`。
- CLI 工具：`aoci`，参数 `{ "command": "scan", "args": ["--json"] }`。
- `tools/pre-execute` hook：写文件前调用 `aoci hook pretool`。
- compaction hook：压缩后调用 `aoci hook codex-compact` 并注入上下文。

## 验证状态

运行完整测试：

```bash
cd D:/aoci-dsh
node --test test/*.test.mjs
```

测试覆盖 MCP 9 工具握手、`aoci` CLI 工具、MCP manager 注册、STALE 拒绝、
跨盘路径跳过和 compaction 注入。

`D:\aoci-dsh\aoci-debug.log` 里的 `mcp status` 应为：

```json
{"name":"aoci","configured":true,"status":{"state":"connected","toolCount":9}}
```

如果不是 `connected`，检查 `repoRoot` 是否存在、`aoci.exe` 是否能运行、以及 DSH
的 MCP manager 日志。
