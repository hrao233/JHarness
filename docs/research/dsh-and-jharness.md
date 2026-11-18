# DeepSeek Harness 与 JHarness 对照

2026-11-18 核查。本机 DeepSeek Harness 位于 `E:/Programfiles/DeepseekHarness`。读取发行包 `resources/app.asar` 内的 `package.json`、`dsh/desktop-runtime.json` 和对应模块的中文 README，桌面及运行时版本均为 `0.2.1-rc.5`。JHarness 以本机工作区为准，基线提交 `84b9dc3`，包含之后的会话登记修复。本文比较实现和发行包说明，未向模型发送对照请求。

DeepSeek 已公开 DSH 的源代码，仓库根许可证为 MIT。旧调研中“运行包中没有明确许可证”的观察有其当时的样本范围，现可直接查官方仓库和第三方许可说明。[官方仓库](https://github.com/deepseek-ai/deepseek-harness) · [许可证](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)

## 从一条消息看差异

| 环节 | DSH | JHarness |
|---|---|---|
| 运行时组装 | Cordis 挂载服务与插件。Agent 驱动器、模型适配、工具注册、会话和界面都有组合位置。预设可以声明 Agent 使用哪些子插件。 | 产品在 Java 中构造 HarnessAgent，显式指定提示、工具白名单、步数、压缩、记忆中间件。用户能安装独立进程工具，Skill 还能提供任务说明。现有外部协议面向工具。 |
| 发给模型的输入 | 系统提示服务按序组装提示段和工具定义。Agent 局部贡献可覆盖同名默认项。 | 固定基础提示要求先查相关文件、引用实际路径、编辑前读原文、三个及以上步骤先建待办。项目记忆、工作区资料、附件和启用的工具还会影响请求。 |
| 执行循环 | 默认驱动器准备模型请求、消费流式输出、执行工具，再按需进入下一步。允许并发的工具和需要独占的调用有各自的调度规则。 | 同样有多步推理与工具执行。普通会话上限 18 步，达到上限会进入总结。允许的操作还取决于会话与审批模式。持久任务有单独的工具装配和恢复流程。 |
| 聊天展示 | 安装包的 dsh-client-ui-chat 根据记录渲染会话，支持按轮折叠工作步骤，最终答案仍然可见。这个显示模块不组装模型请求。 | 实时事件会生成文本、阶段和工具卡。重开会话时前端调用 history，后端 visibleHistory 只返回非空用户和助手文本。实时过程与重开后的聊天记录有可定位的差异。 |
| 历史、上下文与记忆 | 会话事件可派生模型输入和不同视图。安装包将旧消息摘要、工具结果裁剪和图片移出上下文拆成多个模块。仅据此无法判断用户启用了哪种跨会话长期记忆。 | 会话日志、当前模型输入、跨会话项目记忆分开。项目记忆有 MEMORY.md、按日期记录、搜索与归档，开启自动记忆后会加入提取和整理中间件。 |

DSH 可查安装包 `dsh/node_modules/@deepseek-ai/` 下的 `dsh-agent-loop`、`dsh-agent-preset`、`dsh-system-prompt`、`dsh-compaction-basic` 和 `dsh-client-ui-chat`。官方架构文档还区分了持久会话事件、运行中的 Agent 事件和能力事件。[DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

JHarness 对应入口见 [会话构造与系统提示](../../apps/backend/src/main/java/local/jharness/agent/ConversationRuntime.java)、[实时事件](../../apps/backend/src/main/java/local/jharness/agent/ConversationEvents.java)、[历史读取](../../apps/backend/src/main/java/local/jharness/Backend.java)、[React 聊天区](../../apps/ui/src/main.jsx)、[项目记忆](../../apps/backend/src/main/java/local/jharness/memory/ProjectMemory.java)、[持久任务](../../apps/backend/src/main/java/local/jharness/agent/DurableConversation.java)、[外部工具协议](../plugins/external-tools.md)。

## 建议的调整与验收

1. **统一实时聊天和历史回放。** 选一个会读文件、需要审批、最后有结论的任务。运行时和重启后都应能从同一轮展开工具、审批和结果，最终答案保持可见。旧日志缺少的事件按实际记录展示。
2. **让助手行为可选择、可比较。** 借鉴 OpenCode 的具名 Agent 配置，先做“讲解项目”和“执行修改”两个预设。分别定义系统提示、工具和权限，在后端落实约束。用同一项目快照、同一模型、同一推理强度、全新会话，对比两套产品读了哪些文件、何时开始执行、为什么停止。保留请求中的提示来源和工具清单，以便归因。[OpenCode Agent 配置](https://opencode.ai/docs/agents/) · [AgentScope 对照研究](agentscope-for-jharness.md)
3. **让记忆和压缩可追溯。** 在现有上下文预览上显示哪些项目约定进入本轮请求、来自哪里、何时发生历史压缩。分别用同项目新会话、另一项目和长会话检验记忆复用、隔离与压缩后的可追查性。
4. **按真实需求扩大插件接口。** 从提示段贡献或只读运行事件订阅中选一种做试点。明确插件作用域、调用顺序、出错时的行为，再考虑增加可替换的记忆策略。接入前比较普通会话、持久任务与 CLI 的行为。[DSH 能力与事件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [OpenCode 插件](https://opencode.ai/docs/plugins/)

进一步盘点 Harness 时，可以沿任务生命周期检查模型路由和预算、工作区指令与上下文选择、工具协议和执行环境、权限与审批、取消和排队、失败重试和副作用恢复、会话分叉与历史回放、可观测性与验收证据、子任务委派。JHarness 在这些方向的成熟度不同，现有系统已具备多项基础能力。[产品说明](../../README.md) · [中断与恢复](durable-tool-recovery.md)
