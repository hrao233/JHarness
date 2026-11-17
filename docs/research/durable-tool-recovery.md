# 工具副作用与崩溃恢复

调研于 2026-11-17，比较 Pi Durable 1.5.2、Hermes 的定时执行与 JHarness 持久会话。

| 实现 | 执行前记录什么 | 重启后怎么决定 |
| --- | --- | --- |
| Pi Durable | 参数确定后，先落盘 `execute` 阶段、实际参数和工具的 `replay` 策略，缺省为 `unsafe`。 | 只有旧记录和当前工具都声明 `safe` 才重放；否则完成为 `interrupted`，保留可用的部分输出。其 SQLite 夹具刻意让外部写入早于结果提交，验证重启后使用同一幂等键重放时，调用可发生两次而唯一副作用只有一次。[工具状态机](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/tool.ts#L177-L226) · [故障测试](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/test/harness-tasks-recovery.test.ts#L65-L145) |
| Hermes Cron | 持久化已认领的执行，再以条件更新转为运行中；记录所有者 PID 和进程启动标识。 | 用所有者身份区分进程存活与 PID 重用。失去所有者的旧尝试以条件更新标为未知；配置允许时，超过时限且疑似卡死的持有者也会单独处理。这个做法用于调度尝试的所有权，不能证明工具副作用已经完成。[执行存储及恢复](https://github.com/NousResearch/hermes-agent/blob/009afb3ac5405274f6efc749c1421d0117868010/cron/executions.py#L295-L410) |
| JHarness | Core 先提交工具派发，再执行。会话投影以派发记录和已提交结果的差集识别未决调用。 | 活动写入者持有两分钟租约；旧写入者消失后，租约仍需过期。副作用不明时，用户按实际效果填写结果，Core 要求提交的调用 ID 集合与未决调用完全一致，再原子写入核对结果和恢复检查点。[工具派发](../../libs/agent-core/src/main/java/io/agentscope/core/tool/ToolExecutor.java#L346) · [会话投影](../../libs/agent-core/src/main/java/io/agentscope/core/session/SessionProjection.java#L60) · [租约](../../libs/agent-core/src/main/java/io/agentscope/core/session/SessionRecorder.java#L62) · [核对](../../libs/agent-core/src/main/java/io/agentscope/core/session/SessionRecovery.java#L190) |

JHarness 的命令和文件工具继续保留人工核对。即使可以确认旧进程已停止，也不能根据进程退出
推断某项写入是否已经生效。验证应在观察到项目内可计数的副作用后强制终止整棵进程树；
下次启动核对同一轮次、同一调用，恢复后再重启一次，检查结果持久化且副作用总数没有增加。
测试需要等待真实租约，不能删改 journal 来模拟租约过期。

先运行 `npm run package:win`，再运行 `npm run test:packaged-recovery`。该用例使用包内
Java 和后端，通过桌面使用的 JSON 管道提交、批准、核对和续跑。它验证同一条命令的
副作用只发生一次，重启后核对结果仍然可读。普通打包冒烟继续覆盖可见的待审批任务；
核对按钮本身和已提交结果时切断进程的场景仍需单独验证。

后续如果要缩短恢复等待，可以独立验证类似 Hermes 的所有者身份判断，保留无法确认时的
租约保底。只有工具自身提供稳定幂等键、旧记录保留可重放契约，且当前实现仍遵守该契约，
才考虑采用 Pi 的自动重放路径。
