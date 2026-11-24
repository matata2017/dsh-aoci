# AOCI-CODE for DeepSeek Harness

这个仓库是 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 的 DSH 集成包，同时也是一个已初始化的 AOCI 治理仓库。仓库自身位于 `D:/work/huanghao/aoci-code`，插件就从本仓库的 `plugin/` 子目录安装，不再依赖任何独立的安装目录。

AOCI 给模型提供一层可维护、可审计、可版本化的仓库认知。DSH 插件把这套能力接成三组工具入口：MCP 工具读写认知、一个 `aoci` CLI 工具做运维、两个 hook 在写文件和压缩上下文时自动介入。

## 目录结构

```text
D:/work/huanghao/aoci-code/
├── bin/aoci.exe               # AOCI CLI / MCP 二进制，来源见文末
├── plugin/                    # DSH bundle：@local/dsh-aoci
│   ├── bin/aoci.exe           # 插件自带二进制
│   ├── index.js               # MCP 注册、CLI 工具、hooks、会话路由
│   ├── cordis.patch.yml       # 默认配置（repoRoot / projects）
│   ├── package.json
│   └── README.md              # 插件接口与多项目配置参考
├── test/                      # node --test test/*.test.mjs
├── .aoci/                     # AOCI 运行时与治理状态（baseline/config）
├── aoci.txt                   # Root manifest
├── aoci.meta.txt              # Meta volume
├── aoci.code.txt              # Code volume（正式索引条目）
├── AGENTS.md                  # 仓库级 Agent 纪律
└── aoci-debug.log             # 插件诊断日志（gitignore，运行时生成）
```

## 安装与重装

在 DSH 会话里执行：

```text
plugin_manager install_bundle "D:/work/huanghao/aoci-code/plugin"
```

卸载用：

```text
plugin_manager remove_bundle "@local/dsh-aoci"
```

安装是把 profile 下的 `@local/dsh-aoci` 链接到本仓库 `plugin/`。改了插件代码或配置后需要重新安装；客户端界面（面板等）的变更通常需要完整重启 DSH 才会加载。

## 配置

配置文件是 `plugin/cordis.patch.yml`，也可以在 DSH 的 Plugins 页面改 `@local/dsh-aoci` 的配置。

### 按会话自动绑定（默认）

省略 `repoRoot` 和 `projects`。插件从会话当前工作目录向上查找 AOCI 项目根目录，无需 `.git`。进入同一项目的子目录时复用绑定，切到另一个项目时在下次调用前重新绑定。带有不完整 AOCI 资产的子项目会显示未绑定，避免使用父项目的索引。

打开项目后调用 `aoci status`（`{"command":"status"}`），核对会话目录、绑定模式、目标 `repoRoot` 和 MCP 回执的实际仓库根。随后使用输出的 MCP server key 对应的工具。根目录不匹配时，插件阻止 AOCI 写入。状态探测可能追加 AOCI 审计日志。

如需固定项目，在插件配置中填写一个绝对路径：

```yaml
repoRoot: 'E:/work/huanghao/pinrong-online'
```

`repoRoot` 优先于 `AOCI_REPO`。两者都未设置时才使用自动绑定。

### 多项目（一个会话内切换）

取消 `projects` 注释可让一个会话绑定多个仓库：

```yaml
projects:
  - projectId: loan-information-boot
    repoRoot: 'E:/work/huanghao/loan-information-boot'
  - projectId: pinrong-online
    repoRoot: 'E:/work/huanghao/pinrong-online'
```

每个项目有独立 MCP 进程、独立索引和独立的工具前缀。调用 `aoci_project`（无参数）列出项目，传 `{"projectId":"pinrong-online"}` 在当前会话中切换；插件重载后选择会重置。切换后记得换用对应前缀的工具，例如 `mcp__aoci_pinrong_online__aoci_maintain`。

更多细节见 [plugin/README.md](plugin/README.md)。

## 暴露的能力

| 入口 | 内容 |
|---|---|
| MCP `mcp__aoci__*` | 9 个工具：`aoci_rules`、`aoci_overview`、`aoci_get_entries`、`aoci_search`、`aoci_maintain`、`aoci_update_entry`、`aoci_remove_entry`、`aoci_header`、`aoci_report` |
| CLI `aoci` | `init`、`scan`、`status`、`verify`、`check`、`doctor`、`index`、`ui`、`hook` 等子命令 |
| pre-write hook | 写文件前调用 `aoci hook pretool`，stale 时拒绝写入，非阻塞提醒注入下一步 |
| compaction hook | 上下文压缩后注入 `aoci hook codex-compact` 的刷新交接 |

DSH 的「MCP 连接器」页面只列 `dsh-mcp-connector` 自己管理的连接；本插件通过原生 `ctx.mcpManager` 注册，所以不在那个页面显示，但会出现在模型的工具列表里。「钩子」页面同理，本插件用原生 `tools/pre-execute` 和 `session/event`，不会显示在 `dsh-codex-hooks` 的记录里。

## 使用 AOCI 认知

AOCI 的认知不是普通搜索结果，而是一套带绑定收据的交付协议。标准顺序是：

1. 调用 `aoci_rules` 读取会话级运行合同。
2. 调用 `aoci_overview`，若 `continuation_required=true` 就原样提交 `next_cursor` 直到 `completed=true`。
3. 用 `host_delivery_confirmation` 确认交付，再提交一次 `model_cognition_attestation`。
4. 之后才用 `aoci_search` / `aoci_get_entries` 补充细节。

不要跳过 attestation 或凭记忆补全 Whole-Index。失败的 attestation 是不可重试的持久状态，规则全文以 `aoci_rules` 的返回为准。

日常维护：

```text
aoci status          # 看索引条目数、基线、治理状态
aoci verify          # 列出缺 Entry / stale / orphan 等 finding
aoci scan            # 重建文件基线
```

当 `verify` 报缺 Entry 时，在模型会话里调用 `aoci_maintain` 获取候选批次，再用 `aoci_update_entry` 写回；完整批次提交后治理状态才会 aligned。

## 验证

```bash
cd D:/work/huanghao/aoci-code
node --test test/*.test.mjs
```

覆盖：MCP 握手与 9 工具可见性、CLI 工具、多项目会话路由、MCP manager 注册参数、pre-write stale 拒绝、跨盘/跨仓路径跳过、compaction 注入。

当前结果（2026-11-24）：10 项中 9 项通过。唯一失败是 `aoci CLI tool is registered and can run status`，原因待查。已确认的事实：直接运行 `./bin/aoci.exe --repo D:/work/huanghao/aoci-code status --json` 返回 `exitCode=0`（`index_entries: 15`），但经插件的 `aoci` 工具以同样参数调用时返回 `exitCode=3` 且输出 `error_code: "config"`。多项目会话路由与 hook 的相关测试均通过，运行时 MCP 与 hook 可用。

运行时可看 `aoci-debug.log`：

```text
mcp registered name=aoci repo=D:/work/huanghao/aoci-code
mcp status={"state":"connected","toolCount":9}
```

## 构建来源

`bin/aoci.exe` 从 `https://github.com/aoci-spec/aoci-code` 的提交 `3d8e4b0048b7ae93d671ffae39db73a44db434d3` 构建（Go 1.27.3，CGO 关闭）。AOCI-CODE 采用 FSL-1.1-MIT（Fair Source）许可证，商用前请阅读上游 LICENSE。
