# Hermes 与 Pi 实现功能盘点

调研于 2026-11-16。Hermes 取自 `D:/Memory/hermes/hermes-agent`，本地 HEAD 为 `009afb3ac5`。Pi 取自 `D:/pi-main`，快照无 Git 元数据，核心公开包清单标记 `1.5.2`。表中的源码路径相对于各自的源码根目录。依据产品菜单、命令注册、实现和测试用例交叉核实，未运行参考应用、接通外部服务或读取已有用户会话和凭据。外部集成的配置与实际可用性需要在相应环境验证。

## Hermes 已实现的产品功能

| 功能面 | 具体能力与交付方式 | 源码线索 |
| --- | --- | --- |
| 交互端 | 经典 CLI、TUI、Electron 桌面、浏览器管理台。TUI 有会话切换、自动续聊、快捷键、状态栏和主题。CLI 有按键录音、连续语音输入和播报。桌面支持不同连接和项目范围。管理台有聊天、会话、文件、模型、用量、日志、Cron、Skill、插件、MCP、渠道、配对、配置和系统页面。功能随客户端而异。 | `hermes_cli/main.py:281`；`hermes_cli/commands.py:85`；`hermes_cli/voice.py:300`；`apps/desktop/src/hermes.ts`；`web/src/App.tsx:191`；`hermes_cli/web_server.py:1010` |
| 会话管理 | 按 ID、名称、目录或最近使用恢复会话，恢复工作目录；命名、历史查询、跨入口交接、分支、重试、撤回、手动压缩、导入导出。支持导出单个会话或完整谱系。Web 管理台接入会话搜索和管理。 | `hermes_cli/commands.py:85`；`hermes_state_portability.py:288`；`hermes_state_portability.py:610`；`hermes_cli/web_server.py:1018`；`tests/hermes_cli/test_web_server_session_search.py` |
| 运行中交互 | 中断、插入指示、排队后续消息、后台运行、旁路提问、仅规划、独立评审、目标和后续唤醒。网关对忙碌会话有实际入队和 steering 分支，持续目标和心跳由单独的逻辑处理。 | `hermes_cli/commands.py:85`；`hermes_cli/cli_commands_mixin.py:1920`；`gateway/run_busy.py:1038`；`gateway/run_goals.py:275`；`gateway/run_heartbeat_restore.py:22` |
| 项目与交付物 | 项目可绑定多个目录、主目录和看板，支持工作树、项目文件与命令工具。工作区有检查点列表、差异预览、按文件恢复和避免覆盖用户后来手改内容的处理。桌面有产物列表与预览，适配的渠道可交付文件、图片与音频。 | `hermes_cli/projects_cmd.py:134`；`hermes_cli/worktree_ops.py`；`tools/checkpoint_manager.py:764`；`tests/tools/test_checkpoint_manager.py`；`apps/desktop/src/app/artifacts/index.tsx`；`gateway/platforms/base.py:1650` |
| 通用工具 | 按 toolset 管理终端、项目文件、网页读取、搜索、文档提取、浏览器、图像和音频等工具。部分工具依赖额外组件、配置或服务；命令层有工具开关、MCP 和技能管理。可用工具集合随入口和配置变化。 | `hermes_cli/main.py:3445`；`website/docs/reference/toolsets-reference.md`；`website/docs/reference/tools-reference.md`；`web/src/App.tsx:211` |
| 上下文与压缩 | 从项目与目录链发现指导文件，支持显式引用和运行时上下文选择。上下文引擎可以替换选择、压缩和工具结果裁剪策略。压缩可以生成有父会话的子记录，保留原始信息，并有失败冷却、恢复和并发协调。 | `agent/prompt_builder.py:1699`；`agent/context_engine.py:48`；`hermes_state_compression.py:244`；`tests/agent/test_prompt_cache_boundary.py` |
| 长期记忆与会话召回 | 原始历史独立于文件记忆。文件记忆区分 `MEMORY.md` 和 `USER.md`，有容量、去重、编辑及稳定的会话级提示词快照。外部记忆提供者可预取并同步；后台整理有成本和运行限制。历史查询使用 SQLite FTS，可选 CJK 分词，并可由 `session_search` 工具召回。 | `tools/memory_tool_store.py:88`；`agent/memory_manager.py:379`；`agent/memory_manager.py:447`；`hermes_state_search.py:1062`；`hermes_state_fts.py:46`；`tests/agent/test_background_review.py` |
| 模型与凭据 | 模型和传输选择、兼容端点、推理强度、快速档、模型回退、凭据池、不同辅助任务的模型配置，以及多模型汇总预设。本地模型有独立运行管理路径。管理台有 OAuth、模型信息和按模型用量。选用的具体服务与凭据由配置决定。 | `hermes_cli/runtime_provider.py:982`；`hermes_cli/fallback_config.py:103`；`hermes_cli/moa_config.py:281`；`agent/credential_pool.py:1006`；`hermes_cli/web_routers/analytics.py:232`；`hermes_cli/local_runtime/supervisor.py:110` |
| 子代理与后台委派 | 可启动子代理或批次委派，跟踪任务状态和进度；异步委派持久记录派发、终态和未送达结果，重启后处理遗留记录。普通委派与跨任务看板是两个机制。 | `tools/delegate_tool.py`；`tools/async_delegation.py:153`；`tools/async_delegation.py:260`；`tests/tools/test_async_delegation.py` |
| 看板与协作 | 多看板、卡片归属、依赖、评论、附件、领取、心跳、阻塞、完成、审阅和尝试历史。工作者可按配置由网关派发，CLI 和可选管理台界面能查看运行结果；支持给自动化请求去重。 | `hermes_cli/kanban_db.py:695`；`hermes_cli/kanban_db.py:1255`；`hermes_cli/kanban_db.py:2269`；`hermes_cli/kanban_db.py:2731`；`tests/e2e/core/kanban/test_kanban_dispatcher_restart.py` |
| 定时、事件与批处理 | Cron 管理定义和每次执行记录，支持暂停、手动执行、失败记录、恢复中断记录和结果交付；还有 Webhook 入口、脚本批处理的检查点与续跑。同一个定时定义与每次运行有不同身份。 | `cron/executions.py:186`；`cron/executions.py:322`；`cron/scheduler.py:2546`；`gateway/platforms/webhook.py:182`；`batch_runner.py:598` |
| API、编辑器与消息渠道 | 一次调用模式、ACP stdio、TUI JSON-RPC、桌面 WebSocket JSON-RPC，以及可选的 OpenAI 风格 HTTP/SSE 服务。API 有会话、运行及任务接口；已提交运行可去重，服务重启后能标记中断。消息网关有可配置适配器、配对和路由，目录中有 Telegram、Discord、Slack、飞书、邮件等实现或插件。 | `acp_adapter/entry.py:95`；`tui_gateway/server.py:716`；`gateway/platforms/api_server.py:3091`；`gateway/platforms/api_server_runs.py:234`；`gateway/platforms/api_server_runs.py:412`；`gateway/run_adapters.py:1824` |
| Skill、插件与外部能力 | 有 Skill 的索引、安装、同步以及工具、钩子、命令、上下文引擎、外部记忆、消息渠道、后台辅助任务等注册点；管理台有独立插件页面和插槽。Web、浏览器、媒体、模型、观测和渠道等目录含需启用或配置的随附插件。 | `agent/prompt_builder.py:1359`；`hermes_cli/plugins.py:457`；`hermes_cli/plugins.py:717`；`hermes_cli/plugins.py:974`；`hermes_cli/plugins.py:1350`；`web/src/plugins/slots.ts` |
| 配置档案与运维 | 创建、切换、克隆、导入导出配置档案；可配置独立的会话、记忆、模型和网关。另有诊断、日志、状态、用量统计、配置与连接管理、SQLite 一致性备份、快速快照、更新前备份和恢复。 | `hermes_cli/profiles.py:1335`；`hermes_cli/profiles.py:2226`；`hermes_cli/backup.py:488`；`hermes_cli/backup.py:1174`；`hermes_cli/web_routers/analytics.py:79`；`hermes_cli/web_routers/ops.py:85` |

命令、工具和随附 Skill 的完整上游目录可继续查阅 `website/docs/reference/cli-commands.md`、`website/docs/reference/slash-commands.md`、`website/docs/reference/skills-catalog.md` 和 `website/docs/reference/optional-skills-catalog.md`。

## Pi 已实现的产品功能

| 功能面 | 具体能力与交付方式 | 源码线索 |
| --- | --- | --- |
| 主 CLI 与终端体验 | 交互 TUI、只输出最终文本的模式、JSON 事件模式、双向 JSONL RPC、TypeScript SDK。交互端有多行编辑、文件补全、粘贴图片、工具与推理折叠、编辑器和状态栏、快捷键、全屏与搜索。工具执行、模型、会话及发送队列可用命令或 RPC 控制。 | `packages/coding-agent/src/main.ts:1015`；`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3540`；`packages/coding-agent/src/modes/rpc/rpc-mode.ts:409`；`packages/tui/src/tui-alt-screen.ts:203` |
| 两类输入队列 | `steer` 在运行中介入；`followUp` 在当前运行完成后推进。TUI 可以取消、取回排队内容并编辑；RPC 有同类操作和关联响应。 | `packages/agent/src/agent.ts:275`；`packages/agent/src/agent-loop.ts:185`；`packages/agent/src/agent-loop.ts:304`；`packages/coding-agent/test/rpc-prompt-response-semantics.test.ts:184` |
| 会话树与移植 | 主 CLI 在 JSONL 内保存有 `id` 和 `parentId` 的条目。可在同一会话树切换节点，从旧消息派生新会话，克隆当前活动分支，搜索选择会话、重命名、压缩、导入、HTML/JSONL 导出并通过配置支持的服务分享。压缩另外保存摘要和首条保留记录，构造当前分支的模型视图。 | `packages/coding-agent/src/core/session-manager.ts:577`；`packages/coding-agent/src/core/session-manager.ts:1180`；`packages/coding-agent/src/core/session-manager.ts:1618`；`packages/coding-agent/docs/session-format.md:209`；`packages/coding-agent/src/core/slash-commands.ts:17` |
| 项目工具与资源 | 默认读文件、执行命令、编辑、写入；可选择 `grep`、`find`、`ls` 等工具或按配置关闭工具。支持项目指导文件、Skills、提示词模板、主题以及用户和项目作用域的资源。可保存项目对可执行扩展的信任选择。 | `packages/coding-agent/src/core/tools/index.ts:195`；`packages/coding-agent/src/core/settings-manager.ts:85`；`packages/coding-agent/docs/configuration.md`；`packages/coding-agent/src/core/slash-commands.ts:17` |
| 模型、OAuth 和本地推理 | 提供方目录、模型能力、API Key/OAuth、兼容端点、模型范围与切换、推理档位、每会话模型选择和本地模型管理。扩展可提供虚拟模型，按请求或重试选择实际模型。 | `packages/coding-agent/docs/models.md:7`；`packages/coding-agent/docs/virtual-models.md:7`；`packages/ai/catalog/README.md:19`；`packages/coding-agent/src/extensions/index.ts:7` |
| 扩展与包管理 | 从 npm、Git 或本地安装、更新和卸载资源包。扩展可加工具、命令、UI、状态、模型与会话钩子，可重载。MCP、动态工具发现、Code Mode、llama.cpp 管理有随附实现。MCP 支持调节工具的直接、按需和隐藏等暴露方式。子代理、计划模式、待办、权限弹窗和环境替换分别有扩展示例。 | `packages/coding-agent/src/core/package-manager.ts:1106`；`packages/coding-agent/src/core/extensions/types.ts:1659`；`packages/coding-agent/src/extensions/index.ts:7`；`packages/coding-agent/docs/mcp.md:191`；`packages/coding-agent/examples/extensions/README.md:17` |
| Durable 库 | 独立 JavaScript 库，提供持久化提交和请求去重、运行中的两类输入、信号等待与唤醒、检查点、异常恢复、会话分叉、上下文投影、工具挂起、子任务所有权与取消、任务图、用量、可订阅投影及分页历史。存储有 SQLite、JSONL 等实现。 | `packages/durable/src/harness/harness.ts:133`；`packages/durable/src/harness/submissions.ts:220`；`packages/durable/src/harness/scheduler.ts:1709`；`packages/durable/src/harness/transcript.ts:51`；`packages/durable/README.md:882`；`packages/durable/test/harness-tasks-recovery.test.ts` |
| Chord 应用框架 | 可独立使用的类型化契约、对象、文档、存储、订阅与差量更新、宿主与工作者、Web/TUI/React 端、插件加载和热部署，为跨进程应用提供基础。 | `packages/chord/README.md:14`；`packages/chord/src/node/plugins/index.ts:24`；`packages/chord/src/node/app/index.ts:16` |
| P2、P2 Mac 与 P3 | P2 是带实现的独立实验应用，使用 Durable 和 Chord，包含项目/工作区、会话树、草稿、搜索、文件、产物、终端、子代理、设备和共享、备份、语音、MCP 等插件。P2 Mac 是伴随原型。P3 是后续实验，快照里有会话服务契约、创建、改名、归档/恢复及集成测试，其他完整能力多处于切片计划。 | `apps/p2/README.md:5`；`apps/p2/src/runtime/worker.ts:753`；`apps/p2/plugins/chat/worker.ts:264`；`apps/p2-mac/README.md`；`apps/p3/docs/slices/README.md:8`；`apps/p3/plugins/sessions/server.ts:94`；`apps/p3/test/sessions.test.ts:52` |
| 测量与评测 | 独立 Telemetry 库支持类型化指标、轨迹、上下文传播和适配器契约；Chord 提供 SQLite 观测存储。单独的 eval 工具支持冒烟、对照测试、保留原生对话与指标比较。 | `packages/telemetry/README.md:69`；`packages/telemetry/README.md:185`；`packages/chord/README.md:109`；`packages/evals/README.md:45` |

Pi 主 CLI 的默认工具不包含计划模式和子代理。独立的 Durable、Chord、P2/P3 和随附示例的功能分别计入各自层级。Pi 的工作目录信任约束项目资源加载；主 CLI 的进程、文件与网络访问受启动环境权限约束。依据 `README.md:17`、`README.md:91`、`packages/coding-agent/src/core/sdk.ts:403`。

主 CLI 的完整命令表、RPC 操作和资源规则见 `packages/coding-agent/docs/cli.md`、`packages/coding-agent/docs/slash-commands.md`、`packages/coding-agent/docs/rpc-commands.md` 和 `packages/coding-agent/docs/configuration.md`。

## 架构如何支持这些功能

### Hermes

多个入口复用 Python 的 `AIAgent` 和对话循环。入口各自负责传输、用户交互、权限确认和生命周期。例如 TUI 使用 JSON-RPC，消息网关管理会话路由与适配器，Cron 为每次执行创建运行上下文，API 接住 SSE 和运行控制。管理台通过独立路由提供操作面。依据 `run_agent.py:241`、`agent/conversation_loop.py:1695`、`tui_gateway/server.py:716`、`cron/scheduler.py:2485`。

`SessionDB` 用 SQLite/WAL 承载会话、消息和运营数据。FTS 与消息变更同步。压缩由会话谱系记录，文件记忆与模型请求中的记忆快照各有边界。后台委派、看板和定时执行各有自己的身份、状态与恢复记录，工具、客户端和自动化共享底层 Agent。依据 `hermes_state.py:451`、`hermes_state_common.py:282`、`hermes_state_schema.py:1006`、`tools/memory_tool_store.py:88`。

### Pi

`pi-ai` 统一模型接口，`pi-agent-core` 处理轮次、事件和两种输入队列。主 CLI 通过 SDK 组装 `Agent`、自己的 `AgentSession`、JSONL `SessionManager`、项目资源与扩展，再由 TUI、输出模式和 RPC 复用。主 CLI 的会话树与运行中队列可以分别追溯到这两层。依据 `packages/coding-agent/src/core/sdk.ts:191`、`packages/coding-agent/src/core/sdk.ts:403`、`packages/coding-agent/src/core/session-manager.ts:577`。

Durable 库有独立的持久会话、提交记录、调度器和恢复逻辑。它在提交后发布变化，订阅可以还原运行状态和分页转录。它也支持等待信号、记录任务归属和在父子任务之间传播取消。P2 使用该库，并用 Chord 组合跨进程界面、插件和订阅。依据 `packages/durable/src/session/transaction.ts:367`、`packages/durable/src/harness/view.ts:200`、`packages/durable/src/harness/scheduler.ts:1709`、`apps/p2/src/runtime/worker.ts:753`。

## JHarness 应纳入的产品能力

| 能力包 | JHarness 已有基础 | 明确交付与验收 |
| --- | --- | --- |
| 桌面交互与会话工具 | 流式对话、附件、历史、导航 | M2/M3 接入运行中补充指令、排队及取回编辑、命名、分支、克隆、导入和导出。能在不同分支比较输出，并保留原会话。 |
| 任务与作用域 | `AgentSession` 在 Java 库内，桌面会话流和项目审批独立 | M2/M4 给任务、运行尝试、工具调用与审批稳定身份，显示所有者、父子关系、等待理由和状态。重启后从界面继续同一个任务，取消父任务遵守子任务所有权。 |
| 项目工作台与交付物 | 文件读写、Git 视图、命令、待办、检查点、工作树 | M4 已把待办计划、命令证据、交付物、文件检查点关联到同一运行；任务报告可查看退出码、输出和前后差异，打开应用数据目录中的交付物，按文件恢复或整组预检后回退一次运行。桌面可从当前 Git 提交创建独立工作树并把未提交修改和未合并提交作为清理门槛；工作树合并审阅和验收标准核验仍待补。 |
| 上下文和知识工作台 | 项目记忆、Skill、会话日志和自动压缩 | M3 区分项目事实、个人偏好、指导文件与原始历史；展示模型可见摘要及来源。基于真实长会话评估中英文本召回、可重建索引和提示词缓存，保留可定位的历史引文。 |
| 模型与工具管理 | OpenAI 兼容设置、推理档与已有工具审批 | M5/M9 提供角色模型、可见的回退及成本、MCP 能力发现与按项目启停。用受控模拟提供方验证故障切换与明确的来源显示。 |
| 可扩展产品 | Java 能力注册器、进程宿主、项目 Skill | M5 接入桌面的安装、启停、诊断与版本管理。通过一个独立工具扩展和一个上下文扩展验证同一宿主接口，随后增加模型、存储或其他所需能力。 |
| 多入口与后台自动化 | Electron 协议、库内网关、部分任务基础 | M7/M8 在 CLI 和桌面间共享同一任务身份；增加按时间与事件触发、运行记录、重复去重、显式审批、摘要和失败重试。暂停一个计划后可明确看到它是否仍有运行中的任务。 |
| 管理运维与评测 | 本地构建、测试预算、基本日志 | M6/M9 增加升级、数据备份和恢复、配置档案、用量和诊断。固定场景评估任务完成、重复副作用、上下文召回、插件故障和升级回归，记录可比较的用量与耗时。 |

依据这些功能包推进 [JHarness 产品成熟度路线图](../roadmap/jharness.md)。

## JHarness 对具体实现的采纳

Hermes 的会话召回不是对 JSON 文件做全量字符串扫描，而是把消息同步到独立的 SQLite FTS 投影，并为中文提供专门分词路径；原始会话仍是事实源。JHarness 采纳了相同的基本分层，但把词元化限制在 Java 内实现：拉丁词转小写词元，CJK 连续文本生成相邻字符 bigram。这样无需随包携带原生分词扩展，也能让“认证模块”这类中文短语通过 `认证 AND 证模 AND 模块` 获得高精度召回。

JHarness 还记录了每个会话已提交的 head sequence。head 未变化时跳过历史投影重建；索引损坏或删除后，下一次扫描可以从追加式会话日志重新生成。当前实现参考 Hermes `hermes_state.py`、`hermes_state_fts.py` 和 `hermes_state_search.py` 的职责划分，而不是复制其 Python/SQLite 代码。

Pi 的扩展系统通过清单、安装状态和版本化宿主接口隔离扩展生命周期，Hermes 则把工具、钩子、上下文和渠道放在不同注册点。JHarness 的第一个桌面插件切片采用更窄的进程工具协议：清单只声明工具，安装不执行代码，启用后才懒启动独立进程。这样先验证安装、能力发现、调用、超时、诊断和卸载，再扩展模型、上下文、存储和渠道槽位。

浏览器能力采用与 Hermes 可选工具集类似的思路：独立插件接入浏览器，而不是把浏览器状态写进核心 Agent。JHarness 选择 Chrome DevTools Protocol 作为 Edge 与 Chrome 的共同控制面，先实现页面导航、标签页、正文提取和网页检索，并把页面内容继续视为不可信证据。

Hermes 的检查点管理会在文件操作前后保存证据，并在恢复时处理用户后续手改；它用 shadow Git 对象库去重快照，并通过 agent-write ledger 区分 Agent 写入与用户后续修改。JHarness 的文件级模型保存有界 before/after 快照，以 SHA-256 判断当前内容是否仍等于任务结束状态。整组恢复沿用 Hermes 的“先全量预检、后执行”和“回退前留审计”原则：每个路径以最早 before 和最新 after 构成恢复契约，任一冲突阻止全部写入，部分失败则逆序撤销。

Hermes 的工作树流会在创建前解析最新远端基线，给工作树加锁，并在删除前检查 dirty 状态、未推送提交、合并状态和浅克隆边界；失败创建会清理半成品目录和分支。JHarness 的第一版更保守地使用本地 `HEAD`，把工作树放在 App 数据目录以避免修改用户 `.gitignore`，以 `status --porcelain` 和 `<baseCommit>..HEAD` 计数作为删除门槛，并只在用户明确确认丢弃时强制清理。远端同步、仓库锁、PR 合并判定和本地/远端双基线仍待补。

任务报告同时保存 `todo_write` 计划、命令退出码与输出、交付物元数据和文件改动，使一次运行可以被复核；验证工具产生的退出码证据与任务验收结论仍是两层不同概念。
