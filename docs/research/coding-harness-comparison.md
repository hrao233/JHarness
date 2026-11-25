# 编码 Agent 的工具、反馈与评测

调研日期 2026-11-25。下文的产品行为取自各项目文档，基准成绩取自实际运行评测的团队。JHarness 的本地能力需由其源码或本地运行验证。

## 三种编码工作流

| 产品 | 一个编码任务怎样推进 | 值得比较的具体行为 |
| --- | --- | --- |
| Aider | 初始上下文可以包含仓库地图，按文件间依赖和当前对话筛选类、函数与签名。模型据此定位需要细读的文件。用户可配置测试命令，在改动后把失败输出送回模型。 | 当问题只给出一个类名时，观察定位实现和调用方消耗多少轮读取。仓库地图本身也占用输入预算。[仓库地图](https://aider.chat/docs/repomap.html) · [Lint 与测试](https://aider.chat/docs/usage/lint-test.html) |
| Claude Code | 模型根据上一轮的工具结果决定继续搜索、读写文件或运行测试；用户可以在执行中补充要求。一次用户提示开始一个回合，文件编辑工具的改动可随会话检查点恢复。 | 恢复文件和恢复对话可分别选择。若某文件只被 Bash 命令修改过，回退不会恢复它；若编辑工具此前已跟踪过该文件，随后的 shell 改动也可能被回退。[工作循环](https://code.claude.com/docs/en/how-claude-code-works) · [检查点的范围](https://code.claude.com/docs/en/checkpointing) |
| Cline | 可以先在 Plan 模式阅读代码、讨论方案，再带着同一段对话切到 Act 执行。启用检查点后，Cline 用独立的 Git 仓库记录工具操作后的项目文件状态，支持查看差异。 | 可以只恢复文件、只恢复对话或一并恢复。若要保留对失败原因的讨论再重做实现，可以只恢复文件。文档也提示大型仓库的快照会增加磁盘占用和运行时间。[Plan 与 Act](https://docs.cline.bot/core-workflows/plan-and-act) · [检查点](https://docs.cline.bot/core-workflows/checkpoints) |

## 公开实测怎样解读

### Aider 把方案生成和文件编辑拆为两次调用

Aider 在 133 道 Exercism Python 练习上比较了单阶段编辑和 Architect/Editor 两阶段编辑。一个较容易解释的对照是两边都用 Claude 3.5 Sonnet 和 diff 格式，单阶段通过率为 77.4%，两阶段为 80.5%，相差 3.1 个百分点。两阶段给模型额外一次请求来把方案转成文件改动。作者报告的最高值 85.0% 则同时使用了 o1-preview、另一款编辑模型和整文件编辑格式。报告没有给出前述差值的置信区间，也没有匹配两种流程的调用预算。样本针对小型 Python 源文件，未测量 Java 项目跨模块定位或 Windows 命令执行。[原始实验及完整分组](https://aider.chat/2024/09/26/architect.html) · [题集与指标](https://aider.chat/docs/leaderboards/edit.html) · [两阶段调用机制](https://aider.chat/docs/usage/modes.html)

### LangChain 固定模型，修改 Deep Agents 的执行流程

LangChain 在 Terminal-Bench 2.0 的 89 项任务上固定 GPT-5.2-Codex，由 Harbor 启动沙箱并验证结果。团队查看执行记录后发现，模型会在首次写出看似可用的代码后结束，也会多次编辑同一文件却重复相同思路。随后他们调整启动时提供的目录与工具信息、结束前的验证提示、重复编辑提醒和分阶段推理预算。报告成绩从 52.8% 升到 66.5%，提高 13.7 个百分点。各项调整共同参与了最终配置，文中没有给出每个机制独立贡献的分数。团队也使用该题集的执行记录指导优化，迁移到另一类任务的收益仍须检验。[LangChain 的方法、结果与执行记录示例](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)

### 同一套工具也会因模型或运行资源而改变分数

- **换模型。** Anthropic 在 500 道 SWE-bench Verified 题上使用一套研究用框架，给模型 Bash 和文本编辑工具，由原项目对应的测试判分。相同框架下，旧版 Claude 3.5 Sonnet 得到 33%，升级版得到 49%。这组数字衡量特定模型与研究框架的组合，无法据此推算 Claude Code 客户端的成绩。[Anthropic 的实验设计与结果表](https://www.anthropic.com/research/swe-bench-sonnet)
- **改资源。** Anthropic 在另一项 Terminal-Bench 2.0 实验中固定 Claude 模型、框架和题目，改变六档资源配置。从严格执行每题资源上限到取消上限，成功率提高 6 个百分点（p < 0.01），基础设施错误率从 5.8% 降至 0.5%。更宽裕的资源也允许模型采用更耗内存的解法。比较本机 harness 时，应同时记录运行时间上限、可用 CPU 和内存，并区分测试失败与运行环境故障。[Anthropic 的资源配置对照实验](https://www.anthropic.com/research/infrastructure-noise)

## JHarness 当前分支与本地验证

基线为 `feature/plugin-creation-mode` 的 `60e77b2`。本轮从源码核对普通会话的提示、文件编辑和任务报告，并用工作区已有的 Java JAR 运行 CLI doctor、后端端到端用例，以及三个独立的命令验收场景。doctor 返回后端版本 0.1.0，端到端用例通过，约 60 秒。三个附加场景复用该用例的临时项目、本地模拟模型和真实 Java 后端，经过工具调用、命令批准、任务报告和绑定验收的完整链路。这里没有测真实模型自主选工具的能力，也没有操作桌面 UI。[端到端入口](../../tests/e2e/backend.test.cjs) · [CLI 入口](../../apps/cli/jharness-cli.cjs)

| 临时项目的操作 | 后端记录 | 用户能据此得出的结论 |
| --- | --- | --- |
| 独立运行 `node -e "process.exit(7)"` | 命令退出码 1，状态 FAILED | 可以判断失败。子进程原始退出码 7 在 Windows PowerShell 宿主层变成了 1。 |
| 运行 `node -e "process.exit(7)"; Write-Output done` | 命令退出码 0，状态 SUCCEEDED。绑定期望退出码 0 后为 PASSED。 | 末尾输出成功会掩盖前一项失败。报告准确反映了外层 shell 状态，拿它证明具体测试通过会发生误判。 |
| 在 README 中检查 ORCHID-27，检查成功后同一轮用 edit_file 将它改成 ORCHID-28，再绑定先前命令 | 旧命令退出码 0，验收仍为 PASSED，磁盘中已是 ORCHID-28 | 证据能证明测试当时的状态，界面还需要表达其与最终改动的先后关系。 |

命令实现用 Windows PowerShell 执行完整脚本，再读取宿主进程退出码。验收会核对命令、会话和运行 ID，并支持针对完整输出做 JSON Schema 校验。对退出码核验的路径，命令与后续文件检查点的时间关系没有参与判定。[命令执行](../../apps/backend/src/main/java/local/jharness/agent/ProjectCommand.java) · [验收实现](../../apps/backend/src/main/java/local/jharness/agent/TaskReportStore.java)

## 建议讨论的顺序

1. **给构建、测试提供独立命令入口。** 对单个原生程序直接取得进程退出码，或在已知命令模板中立即保存并返回它。保留通用 PowerShell 脚本的原有执行语义，并把其证据标为“脚本退出码”。用上表两条命令和常见的 Maven 包装脚本回归。验收时要能看出实际测试进程失败，即使后面还有打印日志的步骤。
2. **在任务报告中标出测试以后发生的修改。** 第一期可以仅覆盖 Harness 已记录的文件写入，把历史成功保留，并在绑定旧证据时显示“测试后又修改了 README.md”，让用户选择重新运行。用“测试→改文件→绑定旧证据→重新测试”验证完整体验。首版显示修改路径，由人判断其与该测试是否相关。兼容旧报告时，缺少版本信息应明确展示。后续再评估 shell、插件和用户手动改动的覆盖方式。
3. **用项目内真实任务比较下一项投入。** 初选一个跨模块定位题、一个 Java 修复题、一个中断恢复题。固定起点、模型、推理配置、权限和每题预算，各版本每题重复三次。记录隐藏断言通过数、错误宣称完成次数、查找轮数、用时、用量与人工批准次数。样本足以观察具体失败轨迹，后续扩题再估计总体成功率。定位题可比较现有搜索与 Aider 式精简符号地图；当前编辑失败提示对零次命中和多次命中使用同一文案，可低成本对比拆分提示后的重试次数。[编辑实现](../../apps/backend/src/main/java/local/jharness/agent/ProjectTools.java) · [路线图已有的评测方向](../roadmap/jharness.md)
