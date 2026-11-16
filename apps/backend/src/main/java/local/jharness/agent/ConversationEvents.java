package local.jharness.agent;

import io.agentscope.core.agent.Agent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.AgentResultEvent;
import io.agentscope.core.event.ExceedMaxItersEvent;
import io.agentscope.core.event.TextBlockDeltaEvent;
import io.agentscope.core.event.ToolCallDeltaEvent;
import io.agentscope.core.event.ToolCallStartEvent;
import io.agentscope.core.event.ToolResultEndEvent;
import io.agentscope.core.event.ToolResultStartEvent;
import io.agentscope.core.event.ToolResultTextDeltaEvent;
import io.agentscope.core.middleware.ActingInput;
import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.middleware.ReasoningInput;
import io.agentscope.core.message.ToolUseBlock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;
import reactor.core.publisher.Flux;

/** Adapts execution phases and streamed events from one Harness call to the desktop protocol. */
final class ConversationEvents implements MiddlewareBase {
    private final int limit;
    private final ConversationRuntime.Listener emit;
    private final TaskReportStore reports;
    private final Consumer<String> activeRun;
    private int step;

    ConversationEvents(
            int limit,
            ConversationRuntime.Listener emit,
            TaskReportStore reports,
            Consumer<String> activeRun) {
        this.limit = limit;
        this.emit = emit;
        this.reports = reports;
        this.activeRun = activeRun;
    }

    @Override
    public Set<ExtensionPoint> activePoints() {
        return Set.of(ExtensionPoint.ON_REASONING, ExtensionPoint.ON_ACTING);
    }

    @Override
    public Flux<AgentEvent> onReasoning(Agent agent, RuntimeContext context, ReasoningInput input,
            Function<ReasoningInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            String runId = context.getRunId();
            activeRun.accept(runId);
            phase(runId, ++step, limit, "reasoning");
            return next.apply(input);
        });
    }

    @Override
    public Flux<AgentEvent> onActing(Agent agent, RuntimeContext context, ActingInput input,
            Function<ActingInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            String runId = context.getRunId();
            activeRun.accept(runId);
            recordPlan(context, input.toolCalls());
            phase(runId, Math.max(1, step), limit, "acting");
            return next.apply(input);
        });
    }

    void publish(String runId, AgentEvent event) {
        if (event instanceof ExceedMaxItersEvent e) {
            phase(runId, e.getCurrentIter(), e.getMaxIters(), "summary");
        } else if (event instanceof TextBlockDeltaEvent e) {
            emit.event(runId, "text", Map.of("delta", e.getDelta(), "replyId", e.getReplyId()));
        } else if (event instanceof ToolCallStartEvent e) {
            emit.event(runId, "tool-start",
                    Map.of("toolId", e.getToolCallId(), "name", e.getToolCallName()));
        } else if (event instanceof ToolCallDeltaEvent e) {
            emit.event(runId, "tool-args",
                    Map.of("toolId", e.getToolCallId(), "delta", e.getDelta()));
        } else if (event instanceof ToolResultStartEvent e) {
            emit.event(runId, "tool-execution",
                    Map.of("toolId", e.getToolCallId(), "name", e.getToolCallName()));
        } else if (event instanceof ToolResultTextDeltaEvent e) {
            emit.event(runId, "tool-output",
                    Map.of("toolId", e.getToolCallId(), "delta", e.getDelta()));
        } else if (event instanceof ToolResultEndEvent e) {
            emit.event(runId, "tool-end",
                    Map.of("toolId", e.getToolCallId(), "status", e.getState().toString()));
        } else if (event instanceof AgentResultEvent e) {
            var result = e.getResult();
            var reason = result.getGenerateReason();
            emit.event(runId, "result",
                    Map.of("id", result.getId(), "text", result.getTextContent(),
                            "reason", reason == null ? "" : reason.name()));
        }
    }

    private void recordPlan(RuntimeContext context, List<ToolUseBlock> calls) {
        if (context.getSessionId() == null || context.getRunId() == null) return;
        for (ToolUseBlock call : calls) {
            if (!"todo_write".equals(call.getName()) || call.getInput() == null) continue;
            Object raw = call.getInput().get("todos");
            if (!(raw instanceof List<?> items)) continue;
            var steps = new ArrayList<TaskReportStore.PlanStep>();
            for (Object item : items) {
                if (!(item instanceof Map<?, ?> value)) continue;
                steps.add(new TaskReportStore.PlanStep(
                        text(value.get("content")),
                        text(value.get("status")),
                        text(value.get("priority"))));
            }
            try {
                var plan = reports.savePlan(context.getSessionId(), context.getRunId(), steps);
                emit.event(context.getRunId(), "plan", plan);
            } catch (RuntimeException ignored) {
                // The todo tool reports its own validation error; report persistence is best effort.
            }
        }
    }

    private static String text(Object value) {
        return value instanceof String text ? text : "";
    }

    private void phase(String runId, int current, int max, String phase) {
        emit.event(runId, "loop-phase", Map.of("step", current, "phase", phase, "limit", max));
    }
}
