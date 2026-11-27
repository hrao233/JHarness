package local.jharness.agent;

import io.agentscope.core.agent.Agent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.AgentResultEvent;
import io.agentscope.core.event.ExceedMaxItersEvent;
import io.agentscope.core.event.RequestStopEvent;
import io.agentscope.core.event.TextBlockDeltaEvent;
import io.agentscope.core.event.ToolCallDeltaEvent;
import io.agentscope.core.event.ToolCallStartEvent;
import io.agentscope.core.event.ToolResultEndEvent;
import io.agentscope.core.event.ToolResultStartEvent;
import io.agentscope.core.event.ToolResultTextDeltaEvent;
import io.agentscope.core.message.GenerateReason;
import io.agentscope.core.middleware.ActingInput;
import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.middleware.ReasoningInput;
import io.agentscope.core.message.ToolUseBlock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Function;
import reactor.core.publisher.Flux;

/** Adapts execution phases and streamed events from one Harness call to the desktop protocol. */
final class ConversationEvents implements MiddlewareBase {
    static final int MAX_REPEAT_TOOL_CALLS = 8;

    private final ConversationRuntime.Listener emit;
    private final TaskReportStore reports;
    private final Consumer<String> activeRun;
    private String currentRunId;
    private int step;
    private List<ToolSignature> lastToolSignature;
    private int consecutiveRepeats;
    private String stopReason;

    private record ToolSignature(String name, Map<String, Object> input) {}

    ConversationEvents(
            ConversationRuntime.Listener emit,
            TaskReportStore reports,
            Consumer<String> activeRun) {
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
            syncRun(runId);
            activeRun.accept(runId);
            phase(runId, ++step, "reasoning");
            return next.apply(input);
        });
    }

    @Override
    public Flux<AgentEvent> onActing(Agent agent, RuntimeContext context, ActingInput input,
            Function<ActingInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            String runId = context.getRunId();
            syncRun(runId);
            activeRun.accept(runId);
            recordPlan(context, input.toolCalls());
            phase(runId, Math.max(1, step), "acting");
            String repeatStop = checkRepeatedToolLoop(input.toolCalls());
            if (repeatStop != null) {
                stopReason = repeatStop;
                return Flux.concat(next.apply(input), Flux.just(new RequestStopEvent(repeatStop)));
            }
            return next.apply(input);
        });
    }

    void publish(String runId, AgentEvent event) {
        if (event instanceof ExceedMaxItersEvent e) {
            phase(runId, e.getCurrentIter(), "summary");
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
            String text = result.getTextContent();
            if ((text == null || text.isBlank())
                    && reason == GenerateReason.MIDDLEWARE_STOP_REQUESTED
                    && stopReason != null) {
                text = stopReason;
            }
            emit.event(runId, "result",
                    Map.of("id", result.getId(), "text", text == null ? "" : text,
                            "reason", reason == null ? "" : reason.name()));
        }
    }

    private void syncRun(String runId) {
        if (!Objects.equals(currentRunId, runId)) {
            currentRunId = runId;
            step = 0;
            lastToolSignature = null;
            consecutiveRepeats = 0;
            stopReason = null;
        }
    }

    private String checkRepeatedToolLoop(List<ToolUseBlock> calls) {
        if (calls == null || calls.isEmpty()) {
            lastToolSignature = null;
            consecutiveRepeats = 0;
            return null;
        }
        var signature = calls.stream()
                .map(call -> new ToolSignature(
                        call.getName(),
                        call.getInput() == null ? Map.of() : call.getInput()))
                .toList();
        if (signature.equals(lastToolSignature)) {
            consecutiveRepeats++;
        } else {
            lastToolSignature = signature;
            consecutiveRepeats = 1;
        }
        if (consecutiveRepeats >= MAX_REPEAT_TOOL_CALLS) {
            return "检测到连续 " + MAX_REPEAT_TOOL_CALLS + " 次重复执行相同的工具调用，已自动中止循环。";
        }
        return null;
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

    private void phase(String runId, int current, String phase) {
        emit.event(runId, "loop-phase", Map.of("step", current, "phase", phase));
    }
}
