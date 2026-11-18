# 从 AgentScope 到 JHarness：面向桌面开发助手的功能调研

2026-11-18。对照同一工作区的 AgentScope Java `a4306d63d` 和 JHarness `84b9dc3`。本文按用户在真实仓库里完成任务的过程组织功能。源码接线用于判断能力是否进入产品，仓库说明用于解释设计意图。先前实测单独标明，本次没有重新运行全部场景。JHarness 最初移植的是另一份按哈希记录的快照，两个仓库都标记为 2.1.0-SNAPSHOT，也不能据此认定接口或日志格式可互换。[移植来源](../upstream/agentscope-provenance.md)

## 先选对参考对象

| 想了解的体验 | 建议参照 | 对 JHarness 的意义 |
|---|---|---|
| 用户怎样创建和配置助手 | [Paw 中文说明](../../../agentscope-java/agentscope-examples/agents/agentscope-paw/README_zh.md)和[创建页](../../../agentscope-java/agentscope-examples/agents/agentscope-paw/frontend/src/pages/AgentCreatePage.tsx) | Paw 提供空白、模板和 AI 草稿三种入口。对桌面开发助手，最有价值的是把一组可复用的行为命名、保存，再在项目里选择。浏览器和本地端口只是 Paw 的交付方式。 |
| 编程任务怎样接收指令、控制调用次数和处理排队 | [CodingAgent](../../../agentscope-java/agentscope-examples/agents/agentscope-codingagent/README_zh.md) | 本地 CLI 适合观察单人编程交互。GitHub Issue 到 PR 的部署模式则展示多入口怎么复用线程和调度，涉及真实远端改动，适合作为设计案例。 |
| 谁决定读什么、做什么、何时停下 | [Harness 架构](../../../agentscope-java/docs/dev/zh/docs/harness/architecture.md)和[JHarness 运行时组装](../../apps/backend/src/main/java/local/jharness/agent/ConversationRuntime.java) | Core 负责推理和工具循环，Harness 叠加工作区、上下文及会话，产品选择工具和权限。JHarness 已能让 Electron 和 CLI 共用 Java 后端。模仿 Codex 一类交互时，可以直接把功能落在现有桌面入口。 |

## 按开发任务比较

### 1. 进入项目：智能体、工作区与可复用配置

Paw 把助手的名称、行为提示、工作区和会话联系起来。你看到的内置 claw 在 Settings 里只读，自定义助手则可以修改。JHarness 当前用固定的 JHarness 身份和系统提示构造运行时，同时按项目保存记忆、Skill 与历史。建议先支持“项目配置档案”，例如维护者保存一个“代码审阅”档案，包含行为提示、可用工具和默认审批偏好。档案随运行记录保存版本；旧会话继续使用原有身份，避免改个名称就找不到历史。验收时在同一项目切换两个档案，检查实际工具列表、会话重开和 CLI 的选择是否一致。[Paw 设置页](../../../agentscope-java/agentscope-examples/agents/agentscope-paw/frontend/src/components/AgentSettingsForm.tsx) · [JHarness 运行时](../../apps/backend/src/main/java/local/jharness/agent/ConversationRuntime.java) · [现有 M9 规划](../roadmap/jharness.md)

### 2. 理解任务：上下文、Skill 和长期记忆

AgentScope 分别处理工作区指令、按需加载的 Skill、模型当前能看到的上下文和跨会话记忆。JHarness 已有附件、项目 Skill、上下文预览、项目记忆及压缩，原始事件还可用于搜索和分叉。优先补“为什么这段内容被送进模型”：预览里显示来源、截断和压缩边界。用户发现助手沿用了旧约定时，可以找到来源并修正。验收用一个足够长的会话触发压缩，核对模型请求包含摘要、历史仍能检索原文、另一项目看不到该项目的记忆。[上游上下文](../../../agentscope-java/docs/dev/zh/docs/harness/context.md) · [上游记忆](../../../agentscope-java/docs/dev/zh/docs/harness/memory.md) · [JHarness 会话设计](../decisions/0002-session-and-context.md) · [项目记忆接线](../../apps/backend/src/main/java/local/jharness/memory/ProjectMemory.java)

### 3. 决定何时动手：计划模式、权限与工具

AgentScope 的 Plan Mode 区分读取资料、写专用计划以及经用户确认进入执行。JHarness 已有待办、写入审批、命令审批和任务报告，普通会话组装时启用了任务列表。值得补的是用户可以信赖的“先调查”模式。桌面显示计划及预计改动，Java 后端根据阶段限制工具。审批偏好回答“某次操作谁批准”，计划阶段回答“现在能做哪些事”，两项应独立。验收时在计划阶段分别尝试项目写入、命令和带副作用的插件，均不能改变项目；确认进入执行后再走原来的审批。[上游计划模式](../../../agentscope-java/docs/dev/zh/docs/harness/plan-mode.md) · [JHarness 工具注册与审批](../../apps/backend/src/main/java/local/jharness/agent/ConversationRuntime.java)

### 4. 执行改动：文件系统、命令、沙箱与工作树

AgentScope 将文件操作和执行环境抽象出来，可选宿主或沙箱。JHarness 已提供本地项目工具、PowerShell 命令、文件快照及隔离 Git 工作树。工作树方便审查和合并改动，命令仍以本机用户身份运行。优先让审批框明确显示实际工作目录、执行位置和可能修改的范围。若以后要执行不熟悉项目的构建脚本，再考虑可选容器执行器。验收时区分“回退可追踪文件”和“撤销命令造成的全部影响”，只为具备快照的变更提供可恢复承诺。[上游执行环境](../../../agentscope-java/docs/dev/zh/docs/harness/sandbox.md) · [命令实现](../../apps/backend/src/main/java/local/jharness/agent/ProjectCommand.java) · [工作树实现](../../apps/desktop/electron/worktree-manager.cjs)

### 5. 长任务与中断：会话身份、排队和副作用恢复

上游 Durable 区分 Session、Thread、Turn 与每次尝试的 Run，允许用户重连原任务。JHarness 已有可续跑任务、追加指令、待审批记录和结果未知时的人工核对。应先补桌面与 CLI 的会话登记一致性。先前对临时项目的 16 次并发登记，15 次返回成功，设置中仅余 6 条会话记录；验证范围是目录索引，未证明正文丢失。建议让两个入口使用同一事务更新索引，并让 doctor 只读地启动后端做 ping。验收包括双入口并发创建、重启逐 ID 打开，以及批准命令后进程中断时不重复执行。上游新的 Durable 与现有日志若要互通，应先用旧会话样本验证迁移。[上游 Durable](../../../agentscope-java/docs/dev/zh/docs/harness/durable.md) · [JHarness 续跑入口](../../apps/backend/src/main/java/local/jharness/agent/DurableConversation.java) · [CLI](../../apps/cli/jharness-cli.cjs) · [现有恢复研究](durable-tool-recovery.md)

### 6. 模型与事件：流式反馈、调用预算和失败处理

CodingAgent 示例用中间件限制模型调用，备用模型可在特定过载或限流错误时接手。JHarness 已支持 DeepSeek 与兼容接口，通过事件向 UI 传递文本和工具进度。优先把每轮调用次数、停止原因和实际使用的模型写入任务报告。再考虑用户显式配置备用模型，尤其要处理主模型已输出部分文本或工具参数的情况。验收用模拟服务分别制造“首个响应前限流”和“已输出一半后掉线”，检查消息拼接、工具执行次数和运行记录；备用服务若涉及另一个供应商，选择权应留给用户。[CodingAgent 模型与中间件](../../../agentscope-java/agentscope-examples/agents/agentscope-codingagent/src/main/java/io/agentscope/harness/coding) · [桌面事件映射](../../apps/backend/src/main/java/local/jharness/agent/ConversationEvents.java)

### 7. 委派工作：子智能体与结果汇总

AgentScope 能声明子智能体、委派任务、收集结果。JHarness 的运行时明确关闭静态和动态子智能体。首个有价值的场景是把“只读审阅当前差异”交给独立上下文，父任务拿回带路径和证据的结论。上游提供同步委派超时后转异步的实现；JHarness 若开放此功能，后台任务 ID 必须仍能关联原来的父任务。[委派工具实现](../../../agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/tool/AgentSpawnTool.java) 产品需展示子任务范围、父子关系、调用预算和取消状态。验收时让两个审阅任务分别检查测试与实现，取消其中一个，另一任务仍能返回；子任务不能扩大父任务授权。多人协同写入还需要解决冲突、工作树分配与合并，成本高于只读审阅。[上游子智能体](../../../agentscope-java/docs/dev/zh/docs/harness/subagent.md) · [JHarness 开关](../../apps/backend/src/main/java/local/jharness/agent/ConversationRuntime.java)

### 8. 验证与交付：计划、证据、产物与恢复

上游 Harness 提供退出码和 JSON 结果校验。JHarness 已有验收条件工具、按运行归档的报告、命令证据、产物和恢复。值得提高的是证据的可读性：从每条验收标准点到对应命令、退出码和产物；对未执行或输出截断的检查保留“证据不足”。上游还把验证回执绑定到已固定的任务对象和验收契约版本。JHarness 已检查证据所属会话和运行，可进一步绑定受测文件摘要或工作区检查点。若同一轮测试通过后又修改了代码，旧回执应显示“对应较早版本”。例如 Java 项目打包成功只证明包已生成，用户要求的启动和对话还需要各自的证据。验收时准备一次打包成功但启动失败的样例，报告应保留两种结果。[上游验证器](../../../agentscope-java/agentscope-harness/src/main/java/io/agentscope/harness/agent/verification) · [JHarness 验收与报告实现](../../apps/backend/src/main/java/local/jharness/agent/TaskReportStore.java)

### 9. 扩展与运维：插件、渠道、观测和后台任务

| 能力 | JHarness 可以取用的部分 | 何时再扩大范围 |
|---|---|---|
| Skill、工具插件与 MCP | 区分“给模型的说明”和“实际执行代码”。现有外部插件已有安装、启停和进程协议；工具来源、适用项目、调用失败和取消结果可统一呈现。[上游 Skill](../../../agentscope-java/docs/dev/zh/docs/harness/skill.md) · [本地插件协议](../plugins/external-tools.md) | 用户确有外部 MCP 工具需求，再做适配并验证协议、审批及取消。 |
| 多入口与自动任务 | 上游用渠道接入同一运行时。桌面、CLI 和定时任务先统一会话身份、审批和任务状态，检查同一任务被重复触发时的行为。[上游渠道](../../../agentscope-java/docs/dev/zh/docs/harness/channel.md) · [JHarness 路线图 M7、M8](../roadmap/jharness.md) | 有关闭桌面后仍需运行的明确需求，再拆后台服务。 |
| Studio 与可观测性 | Studio 展示事件与调用轨迹。桌面先把会话、运行、模型步骤、工具调用和错误串起来，支持按次查看和脱敏导出。[Studio 文档](../../../agentscope-java/docs/dev/zh/integration/ecosystem/studio.md) · [JHarness 后端查询入口](../../apps/backend/src/main/java/local/jharness/Backend.java) | 团队协同排障时再评估集中式追踪。 |
| 分布式存储、检索增强与服务集成 | 上游以扩展模块提供数据库、对象存储、RAG、消息队列和服务框架接入。对单机编程体验，现成的本地日志和搜索更容易验收。[上游扩展目录](../../../agentscope-java/agentscope-extensions) · [JHarness 架构](../architecture/agentscope-lite.md) | 出现跨设备续跑、大型资料库检索或多租户部署需求时，再选择对应模块。 |

## 建议的开发顺序

1. **先保住用户已有工作。** 修复跨入口会话登记和 doctor，复用现有打包恢复测试。交付标准是每个成功创建的会话都能重新打开，诊断能识别损坏的运行环境。
2. **再给用户两个明确选择。** 用项目配置档案回答“这次让谁做”，用只读计划模式回答“现在允许做到哪一步”。先让这两项在普通桌面会话生效，并明确持久任务和 CLI 是否支持；作为全产品能力发布前补齐入口一致性。
3. **让结果能解释、能核对。** 把上下文来源、模型预算及每条验收证据连到已有报告。用同一个 Java 小项目走通“读代码、列计划、修改、测试、重开会话查看结果”。
4. **最后引入委派。** 先交付可取消、可追溯的只读子任务，再按实际需求考虑独立工作树写入、容器和后台服务。第一阶段的成功指标是主任务少读无关上下文，同时用户仍能追到结论来自哪个文件与哪次运行。
