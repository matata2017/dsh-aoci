# AOCI-CODE for DeepSeek Harness

这个文件夹是 AOCI-CODE 的 DSH 集成包。

```
D:\aoci-dsh\
├── bin\aoci.exe              # 从 aoci-spec/aoci-code 源码构建的 AOCI 二进制
├── test\                     # 完整测试：node --test test/*.test.mjs
└── plugin\                   # DSH bundle：@local/dsh-aoci
    ├── bin\aoci.exe          # 插件自带二进制
    ├── index.js              # MCP 注册 + aoci CLI 工具 + hooks
    ├── cordis.patch.yml      # 默认 repoRoot 配置
    ├── package.json
    └── README.md
```

## 安装

```bash
plugin_manager install_bundle "D:/aoci-dsh/plugin"
```

安装后插件会把 `aoci --repo <repoRoot> mcp` 注册为 DSH MCP server，工具名是
`mcp__aoci__aoci_rules`、`mcp__aoci__aoci_overview` 等，共 9 个。

## 界面说明

DSH 的「MCP 连接器」页面列出的是 `dsh-mcp-connector` 自己管理的连接；本插件通过原生 `ctx.mcpManager` 注册 AOCI MCP，所以不会出现在那个页面，但模型工具列表里会有 `mcp__aoci__*`。

「钩子」页面列出的是 `dsh-codex-hooks` 的 `hooks.json` 记录；本插件用的是原生 `tools/pre-execute` 和 `session/event` 生命周期监听，不会显示在那个页面，但实际 hook 会执行（见 `aoci-debug.log` 的 `pretool` 行）。

## 配置

默认 `repoRoot` 是 `D:/aoci-code`（AOCI-CODE 源码仓库，本身已有索引）。
要让它管理自己的项目，改 `plugin/cordis.patch.yml` 里的 `repoRoot`，
或安装后在 Plugins 页面修改 `@local/dsh-aoci` 的配置并重载插件。

## 验证

运行完整测试：

```bash
cd D:/aoci-dsh
node --test test/*.test.mjs
```

覆盖：MCP 9 工具握手、`aoci` CLI 工具执行、MCP manager 注册参数、pre-write STALE 拒绝、compaction 注入。

2026-11-22 实测：`7 pass / 0 fail`；DSH 真实日志 `aoci-debug.log` 显示
`mcp status={"state":"connected","toolCount":9}`、`aoci tool definitions=["aoci"]`、
写 `.aoci-hook-test2.txt` 时 `pretool ... exit=0`。deny 分支在测试中用真实
STALE 仓库验证，返回 `kind: "deny"`；跨盘路径（C: 写入 D: 管理仓库）会被跳过，
不会误传给 AOCI。

另做了一次完整条目链路测试（在仓库副本上）：`aoci_maintain` 生成候选 →
`aoci_update_entry`（MCP）写入新条目（495 条）→ 删除文件并 `aoci remove-entry`
清回 494 条，最终 `governance.result = aligned`。

## 构建来源

`aoci.exe` 从 `https://github.com/aoci-spec/aoci-code` 当前提交
`3d8e4b0048b7ae93d671ffae39db73a44db434d3` 构建（Go 1.27.3，CGO 关闭）。
AOCI-CODE 采用 FSL-1.1-MIT（Fair Source）许可证，商用前请阅读上游 LICENSE。
