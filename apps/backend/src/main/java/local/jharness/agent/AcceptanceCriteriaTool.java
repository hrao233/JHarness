package local.jharness.agent;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.util.List;
import java.util.function.Supplier;

/** Records proposed acceptance criteria without claiming that any of them passed. */
public final class AcceptanceCriteriaTool {
    private final TaskReportStore reports;
    private final Supplier<String> activeRunId;

    AcceptanceCriteriaTool(TaskReportStore reports, Supplier<String> activeRunId) {
        this.reports = reports;
        this.activeRunId = activeRunId;
    }

    @Tool(
            name = "acceptance_write",
            description = """
                    Replace the complete acceptance-criteria list for the current task. Use short,
                    testable statements that describe what must be true when the task is complete.
                    This only records proposed criteria; it never marks them passed. A person must
                    later bind deterministic command evidence and verify each criterion.
                    For JSON evidence, use a successful command that prints exactly one JSON value
                    with no other output.
                    """,
            readOnly = false,
            concurrencySafe = false)
    public ToolResultBlock write(
            RuntimeContext context,
            @ToolParam(
                            name = "criteria",
                            description = "Complete replacement list of acceptance criteria")
                    List<String> criteria) {
        String runId = activeRunId.get();
        if (runId == null || runId.isBlank()) runId = context == null ? null : context.getRunId();
        if (context == null || context.getSessionId() == null || runId == null)
            return ToolResultBlock.error("当前任务身份不可用，无法保存验收标准。");
        try {
            var acceptance = reports.saveAcceptanceCriteria(context.getSessionId(), runId, criteria);
            return ToolResultBlock.success(
                    "已保存 " + acceptance.criteria().size()
                            + " 项待核验的验收标准。模型不能将这些标准标记为通过。");
        } catch (RuntimeException error) {
            return ToolResultBlock.error(
                    error.getMessage() == null ? "无法保存验收标准。" : error.getMessage());
        }
    }
}
