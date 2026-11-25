# JHarness

Windows 本地项目助手。桌面窗口由 Electron 和 React 提供，Java 后端使用仓库内本地构建的 Agent Core、Harness 和 OpenAI 兼容模型模块。应用通过进程管道传输 JSON 行和流式事件。

会话通过本地 Harness 执行，Core 负责推理、工具调度、终止与步数用尽后的总结。JHarness 通过中间件和原生事件接收进度，并配置本地工具、审批和项目记忆。运行时保留 AgentScope 的包名和持久化格式，但不再依赖 AgentScope 的发布构件。

## 使用

双击 `release/win-unpacked/JHarness.exe`。在「设置」填写 API Key 并测试连接。DeepSeek 官方预填 `deepseek-flash`。自定义 OpenAI 兼容接口需要填写 Base URL（例如 `https://example.com/v1`）和模型 ID。

打开本机项目目录，发送「读一下 README，解释项目结构」。点击工具记录查看参数与结果。关闭窗口后再次打开，可以从侧栏打开已保存的会话。聊天时，用户输入和 Agent 读取的相关文本会发送给配置的模型服务。

### 输入栏与会话

- 「＋」添加 UTF-8 文本、PNG/JPEG 截图、文件夹目录清单或项目 Skill。图片需要支持视觉输入的模型。文本单项上限 64 KiB，图片单项上限 5 MiB，每条消息最多 8 项。
- Skill 放在项目的 `.agents/skills/<名称>/SKILL.md` 或 `skills/<名称>/SKILL.md`。插件放在 `plugins/<名称>/`，含 `.codex-plugin/plugin.json`，菜单可以选中插件的 Skill。应用将所选 Skill 正文作为本次消息的工作指引传给模型。
- 「Skills 与插件」可显式安装外部工具插件。插件目录需包含 `jharness-plugin.json`，安装后默认停用；启用后，下一轮 Agent 会在独立本地进程中调用其声明工具。协议和安全边界见 [外部工具插件](docs/plugins/external-tools.md)。
- 仓库附带可选的 [Edge/Chrome 浏览器插件](examples/plugins/browser-cdp/README.md)，通过 DevTools Protocol 提供标签页、导航、正文提取、Bing 检索、元素点击、表单填写、等待、刷新和前进/后退；它不会进入默认发行包，也不会自动启用。
- 「请求批准」会在修改或创建文件前暂停，可查看变更后批准或拒绝。「帮我批准」用当前配置的模型发起独立审查请求，只传本次任务和拟议改动。审查结论会显示在会话里，可自动批准或阻止，遇到不确定、超时或过大的变更会转人工。审查请求也会产生 API 用量。「完全访问权限」跳过审批，文件工具仍限制在项目目录内。
- 在输入栏的权限菜单选择「创造模式」，可以让助手在项目里编写或选取工具插件。批准安装卡后，当前项目从下一条消息起使用批准的插件副本。「Skills 与插件」默认管理当前项目，也可显式选择「所有项目」安装共享版本。同一 ID 的项目登记优先。修改源目录后，点击「检查更新」查看文件变化和 SHA-256 摘要，确认后更新所选范围。
- 「可续跑任务」使用持久任务日志执行读取、编辑和创建文件。任务等待审批或中断后，可以在会话底部继续或取消；关闭应用不会丢失任务。任务运行时可以继续输入补充指令，也可以把下一条消息排队为后续任务。
- 应用意外退出后，有遗留审批的项目会在输入栏上方显示「中断的审批」。展开可查看原操作和中断状态。若此前已批准且执行结果待核对，请先检查文件或命令影响。清除记录只会将其从面板移除。
- 可续跑任务遇到结果未知的工具操作时，任务卡会列出具体调用。先在项目中核对实际影响，再逐项标记「已完成」或「未执行」，JHarness 会把核对结果写回任务并继续。
- 左侧「任务中心」列出当前所有项目中运行、排队、等待审批或中断的任务，可跳到对应会话处理。任务列表直接来自持久会话日志，后端重启后仍可读取。
- 左侧「上下文」显示最近一次模型请求所用的模型、消息预览、可用工具、项目上下文项、检查点和压缩记录，便于确认实际发送了什么。
- 上下文面板可把当前会话导出为 Markdown 或原始事件 JSON。Markdown 适合阅读和归档，JSON 保留事件顺序与载荷，便于审计和后续迁移。
- 左侧「检查点」记录 Agent 文件写入前后的快照、命令类型和结果状态。可查看完整前后差异并恢复单个文件；若文件在检查点后又被修改或删除，恢复会中止，避免覆盖后续编辑。
- 左侧「任务报告」按运行归档计划、验收标准、命令与测试证据、交付物和文件改动。计划来自 Agent 的 `todo_write`，验收标准来自 `acceptance_write`。用户选择同一运行的命令证据后，可以核对脚本退出码，也可以用 JSON Schema 核对成功命令的完整输出。例如，让测试脚本只输出 `{"passed":true}`，用包含必需字段和期望值的 Schema 验收。预览截断仍可核对已知退出码。JSON 验收优先读取已归档的完整 UTF-8 日志，上限 262,144 个 UTF-16 代码单元。仅有截断预览、完整日志无法读取或命令未成功时，JSON 验收显示证据不足。交付物保存在应用数据目录并可从桌面直接打开。一次运行涉及多个文件时，可先整组预检再一起恢复；任何文件在任务后又被手改，整组回退都会停止。
- 文件写入、恢复或外部修改已跟踪文件后，报告会在旧命令和已绑定的验收项旁列出受影响路径。当前会话最新一轮结束后，输入区也会提示未覆盖的文件。点击「重新运行」即授权在当前项目执行显示的原命令，沿用同一任务报告，并按原核验配置更新绑定；普通对话不会自动发起重跑审批。
- 左侧「隔离工作树」从当前 Git 提交创建独立 `jharness/*` 分支和 App 数据目录中的工作树，可把实验性改动放在独立项目会话里。未提交修改不会复制到工作树；工作树提交后可审阅 commit、统计和补丁，并在主工作区干净时以未提交、已暂存状态应用，冲突会自动撤销。有未提交内容或未合并提交时，移除默认被阻止，确认丢弃后才强制清理。

除桌面外，可以使用同一个运行时从命令行执行任务：

```powershell
$env:JHARNESS_API_KEY = "..."
$env:JHARNESS_MODEL = "..."
$env:JHARNESS_BASE_URL = "https://api.openai.com/v1"
npm run cli -- run "读取 README 并总结项目结构" --project D:\path\to\project --permission ask
```

CLI 和桌面共用 `settings.json`，并发登记会话时保留每次写入。首次打开旧 CLI 项目时会沿用已登记的项目和会话 ID。`doctor` 在临时目录启动 Java 后端并检查 ping 回复，诊断不会创建项目或会话。Windows 包内提供 `release/win-unpacked/jharness-cli.cmd`。支持 `--json` NDJSON 事件、`ask/assist/full/durable` 审批模式和 `doctor` 诊断。

左侧「数据与运维」显示本地项目、会话、文件和数据量，可打开数据目录、创建完整备份、预检备份并恢复。备份包含桌面设置和全部项目 workspace，排除隔离工作树与可重建搜索索引；每个文件带 SHA-256，恢复前会校验并自动创建当前数据的安全快照。

左侧「自动任务」可创建固定间隔或执行一次的 durable 任务，每个定义拥有独立项目会话和运行记录。支持暂停、恢复、立即运行、取消和失败重跑；同一自动任务已有活动运行时不会重复触发。调度只在桌面应用运行期间生效，等待审批的任务可在任务中心继续。

- 闪电按钮独立控制生成速度。兼容接口可在模型设置里指定服务商支持的 `fast` 或 `priority`，开启后实际发送 `service_tier`，可能产生额外用量费用。DeepSeek 官方接口使用标准档。最终速度取决于服务商和账号。
- 右侧模型按钮打开推理强度滑块。DeepSeek 官方支持关闭、低、高和极高，后端分别发送 `thinking` 和 `reasoning_effort`。没有已选档位时优先选「高」，其次选配置中的第一个档位。兼容接口可勾选模型支持的强度，全部取消时不发送推理参数。连接测试可以带上具体推理强度和快速档位。
- 左侧分别显示最近会话和项目。项目行的「＋」会在该项目新建会话，项目名前的箭头展开或收起会话。
- 最左一列可收起项目栏、添加图片、打开收藏资料库、选用项目 Skill 或插件、搜索项目名、会话标题和消息正文，以及查看当前项目的 Git 状态和暂存前后的差异。消息搜索使用可重建的 SQLite FTS5 索引，英文按词、中文按相邻字符 bigram 召回。
- 会话左侧每条短线对应一条用户消息。悬停预览，点击跳转，当前轮次随滚动高亮。向上查看旧消息时，新回复不会把页面拉回底部。
- 消息下方可复制原文、把内容引用到输入栏，或从「更多消息操作」收藏到本机资料库。Java 后端按会话日志中的消息 ID 保存收藏，点击收藏或正文搜索结果可定位原消息。旧版收藏首次打开时自动迁移。
- 消息下方的分叉按钮可从该消息创建新会话。分叉记录来源，只复制当时的对话基线，不继承未结束的执行；原会话历史保持不变。

Agent 可以浏览目录、按名称查找、读取、编辑和新建项目内的 UTF-8 文本文件。`read_file` 支持最大 8 MiB 的文件。64 KiB 以内默认返回原文，更大的文件默认返回带行号的第一页。指定 `start_line` 和 `line_count` 可定位任意片段，续读使用结果末尾给出的行号。分页默认 120 行，最多 400 行，正文约 16,000 字符，单行超长会标记截断。编辑前后的文件均可达 8 MiB，每次替换唯一匹配的原文片段。审批等待期间文件内容变化会使此次编辑失效。新建文件上限为 64 KiB。新建文件使用已有目录。会话使用 Harness 持久日志。模型 Key 由 Electron 主进程通过 Windows DPAPI 加密，数据位于应用的用户数据目录。

在会话里可以请 Agent 执行构建、测试或查看 Git 状态。命令在项目目录启动 Windows PowerShell，按当前 Windows 用户权限执行。每次执行前都显示完整命令和工作目录，需人工批准；批准续跑后，可续跑任务也使用同一审批入口。工具记录显示脚本退出码和合并输出，长输出保留首尾。可在任务报告的对应命令下打开完整日志。Maven 命令会列出构建期间更新的 Surefire 报告中的失败用例，包括脚本末尾其他步骤成功的情况。命令最多运行两分钟，点击「停止」会取消任务和仍在运行的命令。

### 项目工具与记忆

- `search_text` 搜索项目文本并返回路径、行号、扫描和跳过数量。单文件上限 8 MiB，每次搜索最多读取 64 MiB、检查 3000 个候选文件、遍历 32 层、返回 40 条命中。触及上限时可用 `path` 缩小到源码目录或单个文件继续搜索。`todo_write` 使用 AgentScope Core 的任务状态记录待办。`load_skill_through_path` 读取项目 Skill 的说明和资源。
- `web_fetch` 读取用户批准的 HTTP(S) 地址。若启动环境配置了 `TAVILY_API_KEY`，也可使用 `web_search`，每次会先显示并确认发送给 Tavily 的查询。
- 原始会话继续保存在 AgentScope Session Log，`session_list`、`session_search` 和 `session_history` 可回查同项目的会话。会话变长时，Harness 压缩模型工作上下文，界面仍可读取原始对话。
- `memory_save` 将项目事实保存到长期记忆和每日日志，`memory_search` 和 `memory_get` 可搜索并按行读取。左侧「项目记忆」可搜索长期记忆和每日日志、编辑长期记忆，以及阅读每日和归档日志。不同项目的记忆分别保存在 JHarness 用户数据中。
- 「自动提取和整理记忆」按项目开启。Harness 用当前模型提取长期事实、合并每日日志，并归档超过 90 天的日报。自动步骤会产生额外 API 用量。清理长期记忆和清理原始会话是独立操作。

## 开发

需要 Windows x64、JDK 17+、Maven 和 Node.js 22.13 或更高版本。根目录的 `pom.xml` 是唯一的 Java 构建入口，所有运行时模块都在本仓库内构建，不需要预先安装 AgentScope Maven 构件。

```text
libs/agent-core/        ReAct、消息、事件、工具、中间件、权限与状态
libs/agent-harness/     会话、上下文、工作区、记忆、Skill、审批与插件
libs/model-openai/      OpenAI 兼容与 DeepSeek 选项
apps/backend/           桌面 JSON 管道和 JHarness 产品逻辑
apps/desktop/           Electron 生命周期与安全存储
apps/ui/                React 界面
```

后端产品源码位于 `apps/backend/src/main/java/local/jharness`。根包的 `Backend` 是桌面 JSON 管道入口，`agent` 包负责组装会话、审批、本地工具与事件转发，`memory` 包负责项目记忆。ReAct 和 Harness 通过本地 Maven 模块进入运行包。

| 能力 | JHarness 的入口 |
| --- | --- |
| 会话启动、取消、历史和检查点 | `ConversationRuntime` 使用 `HarnessAgent.streamEvents` 和项目的 Session Log，界面读已提交消息。`TaskReportStore` 投影计划、命令证据和交付物。 |
| 流式推理、工具调度、参数错误处理和步数上限总结 | Core 执行，`ConversationEvents` 通过推理／执行中间件和原生事件把状态映射到桌面。 |
| 项目工具、审批和自动审查 | `agent` 注册 JHarness 的工具与审批回调，Core 通过工具注册表调度。 |
| Skill、上下文压缩和跨会话记忆 | `ConversationRuntime` 配置 Harness，`ProjectMemory` 接入项目的长期记忆和日记。 |

普通会话使用直接流式执行；选择「可续跑任务」时，桌面入口切换到 `AgentSession` 的持久任务路径。结构化输出、备用模型和原生外部工具回填仍需要各自的应用入口。

然后在 JHarness 根目录运行：

```powershell
npm ci
mvn -B -T1C clean verify
& "$env:JAVA_HOME\bin\jlink.exe" --add-modules java.se,jdk.unsupported,jdk.crypto.ec,jdk.charsets,jdk.zipfs --strip-debug --no-header-files --no-man-pages --compress=2 --output runtime
npm test
npm run package:win
```

`mvn clean verify` 会运行 Core、Harness、OpenAI 模型适配器和后端模块的完整测试。`npm test` 使用本地模拟模型服务验证 Java 管道、模型请求、工具权限、流式回复和跨进程会话恢复。设置页的「测试连接」可验证实际账号。打包目录已包含 Java 运行时，使用者可以直接启动。Git 追踪源码和锁文件。

`npm run package:win` 还会隐藏启动打包后的 Electron 应用，等待 React 渲染完成后检查页面文本，避免生成只因路径错误而白屏的 EXE。实际可用产物位于 `release/win-unpacked/JHarness.exe`。

Windows 便携包包含 [版本说明](docs/releases/0.1.0.md)和逐文件 SHA-256 清单。清单记录构建时的 Git 提交和工作区状态；校验会检查包内文件是否有缺失、多出或变化。用 `npm run verify:release` 校验本地包，下载 CI 构建并解压后可用 `npm run verify:release -- <解压目录>` 校验。

[产品成熟度路线图](docs/roadmap/jharness.md)列出了当前状态、后续阶段和每阶段的验收场景。[迁移进度](docs/progress/agentscope-lite.md)记录 AgentScope Lite 的迁移结果与验证。[架构](docs/architecture/agentscope-lite.md)、[设计决策](docs/decisions/)和[调研](docs/research/harness-landscape.md)提供技术背景。
