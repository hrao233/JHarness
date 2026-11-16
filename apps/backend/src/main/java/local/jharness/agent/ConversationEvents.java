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
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Function;
import reactor.core.publisher.Flux;

/** Adapts execution phases and streamed events from one Harness call to the desktop protocol. */
final class ConversationEvents implements MiddlewareBase {
    private final int limit;
    private final BiConsumer<String, Object> emit;
    private int step;

    ConversationEvents(int limit, BiConsumer<String, Object> emit) {
        this.limit = limit;
        this.emit = emit;
    }

    @Override
    public Set<ExtensionPoint> activePoints() {
        return Set.of(ExtensionPoint.ON_REASONING, ExtensionPoint.ON_ACTING);
    }

    @Override
    public Flux<AgentEvent> onReasoning(Agent agent, RuntimeContext context, ReasoningInput input,
            Function<ReasoningInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            phase(++step, limit, "reasoning");
            return next.apply(input);
        });
    }

    @Override
    public Flux<AgentEvent> onActing(Agent agent, RuntimeContext context, ActingInput input,
            Function<ActingInput, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            step = Math.max(1, step);
            phase(step, limit, "acting");
            return next.apply(input);
        });
    }

    void publish(AgentEvent event) {
        if (event instanceof ExceedMaxItersEvent e) {
            phase(e.getCurrentIter(), e.getMaxIters(), "summary");
        } else if (event instanceof TextBlockDeltaEvent e) {
            emit.accept("text", Map.of("delta", e.getDelta(), "replyId", e.getReplyId()));
        } else if (event instanceof ToolCallStartEvent e) {
            emit.accept("tool-start", Map.of("toolId", e.getToolCallId(), "name", e.getToolCallName()));
        } else if (event instanceof ToolCallDeltaEvent e) {
            emit.accept("tool-args", Map.of("toolId", e.getToolCallId(), "delta", e.getDelta()));
        } else if (event instanceof ToolResultStartEvent e) {
            emit.accept("tool-execution", Map.of("toolId", e.getToolCallId(), "name", e.getToolCallName()));
        } else if (event instanceof ToolResultTextDeltaEvent e) {
            emit.accept("tool-output", Map.of("toolId", e.getToolCallId(), "delta", e.getDelta()));
        } else if (event instanceof ToolResultEndEvent e) {
            emit.accept("tool-end", Map.of("toolId", e.getToolCallId(), "status", e.getState().toString()));
        } else if (event instanceof AgentResultEvent e) {
            var result = e.getResult();
            var reason = result.getGenerateReason();
            emit.accept("result", Map.of("id", result.getId(), "text", result.getTextContent(),
                    "reason", reason == null ? "" : reason.name()));
        }
    }

    private void phase(int current, int max, String phase) {
        emit.accept("loop-phase", Map.of("step", current, "phase", phase, "limit", max));
    }
}
