package local.jharness;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.AgentResultEvent;
import io.agentscope.core.event.CustomEvent;
import io.agentscope.core.message.GenerateReason;
import io.agentscope.core.message.MessageMetadataKeys;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.session.SessionRecorder;
import io.agentscope.core.state.AgentState;
import java.util.List;
import java.util.Map;
import reactor.core.publisher.Flux;

/** Owns step transitions for one turn and leaves model and tool operations to ReAct. */
final class AgentLoop {
    private final ReAct react;
    private final RuntimeContext context;
    private final AgentState state;
    private final SessionRecorder journal;
    private final int limit;
    private final String systemPrompt;

    AgentLoop(ReAct react, RuntimeContext context, AgentState state, SessionRecorder journal, int limit, String systemPrompt) {
        this.react = react;
        this.context = context;
        this.state = state;
        this.journal = journal;
        this.limit = limit;
        this.systemPrompt = systemPrompt;
    }

    Flux<AgentEvent> run() {
        return step(1);
    }

    private Flux<AgentEvent> step(int number) {
        return Flux.defer(() -> {
            if (number > limit) return finish(Msg.builder().role(MsgRole.ASSISTANT)
                    .textContent("已达到本轮执行步数上限。")
                    .generateReason(GenerateReason.MAX_ITERATIONS).build());
            state.setCurIter(number);
            journal.step(number - 1);
            return Flux.concat(phase(number, "reasoning"), react.reason(context, systemPrompt, reply -> {
                if (reply == null) return step(number + 1);
                List<ToolUseBlock> calls = reply.getContentBlocks(ToolUseBlock.class).stream()
                        .filter(call -> !call.isServerTool()).toList();
                if (calls.isEmpty() && !reply.getTextContent().isBlank()
                        && (reply.getMetadata() == null || !Boolean.TRUE.equals(
                                reply.getMetadata().get(MessageMetadataKeys.OUTPUT_LIMIT_REACHED)))) {
                    return finish(reply.withGenerateReason(GenerateReason.MODEL_STOP));
                }
                if (calls.isEmpty()) return step(number + 1);
                state.contextMutable().add(reply);
                return Flux.concat(Flux.just(new CustomEvent("step-reply",
                                Map.of("id", reply.getId(), "text", reply.getTextContent()))), phase(number, "acting"),
                        react.act(context, reply.getId(), calls), step(number + 1));
            }));
        });
    }

    private Flux<AgentEvent> finish(Msg reply) {
        state.contextMutable().add(reply);
        journal.result(reply);
        return journal.checkpoint(state, "turn_result").thenMany(Flux.just(new AgentResultEvent(reply)));
    }

    private Flux<AgentEvent> phase(int step, String phase) {
        return Flux.just(new CustomEvent("loop-phase", Map.of("step", step, "phase", phase, "limit", limit)));
    }
}
