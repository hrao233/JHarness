# JHarness

Windows 本地项目助手。桌面窗口由 Electron 和 React 提供，Java 后端使用 AgentScope Core 和 Harness。应用通过进程管道传输 JSON 行和流式事件。

会话通过 AgentScope Harness 执行，Core 负责推理、工具调度、终止与步数用尽后的总结。JHarness 通过中间件和原生事件接收进度，并配置本地工具、审批和项目记忆。

## 使用

双击 `release/win-unpacked/JHarness.exe`。在「设置」填写 API Key 并测试连接。DeepSeek 官方预填 `deepseek-flash`。自定义 OpenAI 兼容接口需要填写 Base URL（例如 `https://example.com/v1`）和模型 ID。

打开本机项目目录，发送「读一下 README，解释项目结构」。点击工具记录查看参数与结果。关闭窗口后再次打开，可以从侧栏打开已保存的会话。聊天时，用户输入和 Agent 读取的相关文本会发送给配置的模型服务。

### 输入栏与会话

- 「＋」添加 UTF-8 文本、PNG/JPEG 截图、文件夹目录清单或项目 Skill。图片需要支持视觉输入的模型。文本单项上限 64 KiB，图片单项上限 5 MiB，每条消息最多 8 项。
- Skill 放在项目的 `.agents/skills/<名称>/SKILL.md` 或 `skills/<名称>/SKILL.md`。插件放在 `plugins/<名称>/`，含 `.codex-plugin/plugin.json`，菜单可以选中插件的 Skill。应用将所选 Skill 正文作为本次消息的工作指引传给模型。
- 「请求批准」会在修改或创建文件前暂停，可查看变更后批准或拒绝。「帮我批准」用当前配置的模型发起独立审查请求，只传本次任务和拟议改动。审查结论会显示在会话里，可自动批准或阻止，遇到不确定、超时或过大的变更会转人工。审查请求也会产生 API 用量。「完全访问权限」跳过审批，文件工具仍限制在项目目录内。
- 闪电按钮独立控制生成速度。兼容接口可在模型设置里指定服务商支持的 `fast` 或 `priority`，开启后实际发送 `service_tier`，可能产生额外用量费用。DeepSeek 官方接口使用标准档。最终速度取决于服务商和账号。
- 右侧模型按钮打开推理强度滑块。DeepSeek 官方支持关闭、低、高和极高，后端分别发送 `thinking` 和 `reasoning_effort`。没有已选档位时优先选「高」，其次选配置中的第一个档位。兼容接口可勾选模型支持的强度，全部取消时不发送推理参数。连接测试可以带上具体推理强度和快速档位。
- 左侧分别显示最近会话和项目。项目行的「＋」会在该项目新建会话，项目名前的箭头展开或收起会话。
- 最左一列可收起项目栏、添加图片、打开收藏资料库、选用项目 Skill 或插件、搜索项目名、会话标题和消息正文，以及查看当前项目的 Git 状态和暂存前后的差异。
- 会话左侧每条短线对应一条用户消息。悬停预览，点击跳转，当前轮次随滚动高亮。向上查看旧消息时，新回复不会把页面拉回底部。
- 消息下方可复制原文、把内容引用到输入栏，或从「更多消息操作」收藏到本机资料库。Java 后端按会话日志中的消息 ID 保存收藏，点击收藏或正文搜索结果可定位原消息。旧版收藏首次打开时自动迁移。

Agent 可以浏览目录、按名称查找、读取、编辑和新建项目内的 UTF-8 文本文件，单文件上限为 64 KiB。编辑时匹配唯一一处原文。新建文件使用已有目录。会话使用 Harness 持久日志。模型 Key 由 Electron 主进程通过 Windows DPAPI 加密，数据位于应用的用户数据目录。

在会话里可以请 Agent 执行构建、测试或查看 Git 状态。命令在项目目录启动 Windows PowerShell，按当前 Windows 用户权限执行。每次执行前都显示完整命令和工作目录，需人工批准。工具记录显示退出码和合并输出，长输出会截断。命令最多运行两分钟，点击「停止」会取消任务和仍在运行的命令。

### 项目工具与记忆

- `search_text` 搜索项目文本并返回路径和行号。`todo_write` 使用 AgentScope Core 的任务状态记录待办。`load_skill_through_path` 读取项目 Skill 的说明和资源。
- `web_fetch` 读取用户批准的 HTTP(S) 地址。若启动环境配置了 `TAVILY_API_KEY`，也可使用 `web_search`，每次会先显示并确认发送给 Tavily 的查询。
- 原始会话继续保存在 AgentScope Session Log，`session_list`、`session_search` 和 `session_history` 可回查同项目的会话。会话变长时，Harness 压缩模型工作上下文，界面仍可读取原始对话。
- `memory_save` 将项目事实保存到长期记忆和每日日志，`memory_search` 和 `memory_get` 可搜索并按行读取。左侧「项目记忆」可搜索长期记忆和每日日志、编辑长期记忆，以及阅读每日和归档日志。不同项目的记忆分别保存在 JHarness 用户数据中。
- 「自动提取和整理记忆」按项目开启。Harness 用当前模型提取长期事实、合并每日日志，并归档超过 90 天的日报。自动步骤会产生额外 API 用量。清理长期记忆和清理原始会话是独立操作。

## 开发

需要 Windows x64、JDK 17+、Maven 和 Node.js。当前后端使用 AgentScope Java `2.1.0-SNAPSHOT` 的本地 Maven 构件。若本机尚未安装该版本，在对应 AgentScope Java 源码根目录构建：

```powershell
mvn -T1C -pl agentscope-harness,agentscope-extensions/agentscope-extensions-model/agentscope-extensions-model-openai -am -DskipTests install
```

后端源码统一位于 `apps/backend/src/main/java/local/jharness` 包。根包的 `Backend` 是桌面 JSON 管道入口，`agent` 包负责组装会话、审批、本地工具与事件转发，`memory` 包负责项目记忆。ReAct 实现通过 Maven 的 Core 依赖进入运行包。

| 能力 | JHarness 的入口 |
| --- | --- |
| 会话启动、取消、历史和检查点 | `ConversationRuntime` 使用 `HarnessAgent.streamEvents` 和项目的 Session Log，界面读已提交消息。 |
| 流式推理、工具调度、参数错误处理和步数上限总结 | Core 执行，`ConversationEvents` 通过推理／执行中间件和原生事件把状态映射到桌面。 |
| 项目工具、审批和自动审查 | `agent` 注册 JHarness 的工具与审批回调，Core 通过工具注册表调度。 |
| Skill、上下文压缩和跨会话记忆 | `ConversationRuntime` 配置 Harness，`ProjectMemory` 接入项目的长期记忆和日记。 |

当前桌面入口使用直接会话流。结构化输出、备用模型、原生外部工具回填以及 `AgentSession` 的持久任务队列需要各自的应用入口。

然后在 JHarness 根目录运行：

```powershell
npm ci
mvn -T1C package
& "$env:JAVA_HOME/bin/jlink.exe" --add-modules java.se,jdk.unsupported,jdk.crypto.ec,jdk.charsets,jdk.zipfs --strip-debug --no-header-files --no-man-pages --compress=zip-6 --output runtime
npm test
npm run package:win
```

`npm test` 使用本地模拟模型服务验证 Java 管道、模型请求、工具权限、流式回复和跨进程会话恢复。设置页的「测试连接」可验证实际账号。打包目录已包含 Java 运行时，使用者可以直接启动。Git 追踪源码和锁文件。

架构与迁移决策见 `docs/architecture/`、`docs/decisions/` 和 `docs/research/`。
