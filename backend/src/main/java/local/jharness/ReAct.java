package local.jharness;

import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.agent.accumulator.ReasoningContext;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.TextBlockDeltaEvent;
import io.agentscope.core.event.ToolCallDeltaEvent;
import io.agentscope.core.event.ToolCallStartEvent;
import io.agentscope.core.event.ToolResultEndEvent;
import io.agentscope.core.event.ToolResultTextDeltaEvent;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.middleware.ActingInput;
import io.agentscope.core.middleware.AgentInput;
import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.middleware.MiddlewareBase.ExtensionPoint;
import io.agentscope.core.middleware.MiddlewareChain;
import io.agentscope.core.middleware.ModelCallInput;
import io.agentscope.core.middleware.ModelRequestPreparer;
import io.agentscope.core.middleware.ReasoningInput;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.session.SessionRecorder;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.util.JsonUtils;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Binds AgentScope model, context, tools and journal primitives to JHarness's loop. */
final class ReAct {
    private final ReActAgent components;
    private final List<MiddlewareBase> middleware;

    ReAct(ReActAgent components) {
        this.components = components;
        this.middleware = components.getMiddlewares().stream()
                .sorted(Comparator.comparingInt(MiddlewareBase::order).reversed()).toList();
    }

    Flux<AgentEvent> run(Msg message, RuntimeContext context, SessionLog log) {
        return Flux.usingWhen(
                Mono.fromCallable(() -> new SessionRecorder(log, message.getId(), context.getRunId(), null)),
                journal -> {
                    AgentState restored = journal.initial().restore();
                    AgentState state = restored == null ? AgentState.builder().userId(context.getUserId())
                            .sessionId(context.getSessionId()).build() : restored;
                    var rc = RuntimeContext.builder(context).agentState(state).build();
                    rc.put(SessionRecorder.CONTEXT_KEY, journal);
                    var messages = new ArrayList<>(List.of(message));
                    for (var hook : hooks(ExtensionPoint.ON_AGENT_STATE_READY)) {
                        hook.onAgentStateReady(components, rc, state, messages);
                    }
                    return journal.start(messages, state)
                            .thenMany(chain(ExtensionPoint.ON_AGENT, rc, MiddlewareBase::onAgent, input ->
                                Flux.defer(() -> {
                                    state.contextMutable().addAll(input.msgs());
                                    return systemPrompt(rc).flatMapMany(system ->
                                            new AgentLoop(this, rc, state, journal, components.getMaxIters(), system).run());
                                })).apply(new AgentInput(messages)))
                            .concatWith(Flux.defer(() -> journal.finish(state, "completed").thenMany(Flux.empty())))
                            .onErrorResume(error -> journal.finish(state, "failed")
                                    .onErrorResume(cleanup -> { error.addSuppressed(cleanup); return Mono.empty(); })
                                    .thenMany(Flux.error(error)));
                },
                journal -> Mono.fromRunnable(journal::close),
                (journal, error) -> Mono.fromRunnable(journal::close),
                journal -> Mono.<Void>fromRunnable(journal::close).subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic()));
    }

    private Mono<String> systemPrompt(RuntimeContext rc) {
        Mono<String> prompt = Mono.just(components.getSystemPrompt());
        for (var hook : hooks(ExtensionPoint.ON_SYSTEM_PROMPT)) {
            prompt = prompt.flatMap(value -> hook.onSystemPrompt(components, rc, value));
        }
        return prompt;
    }

    Flux<AgentEvent> reason(RuntimeContext rc, String system, Function<Msg, Flux<AgentEvent>> next) {
        return Flux.defer(() -> {
            var messages = new ArrayList<Msg>();
            if (!system.isBlank()) messages.add(Msg.builder().role(MsgRole.SYSTEM).textContent(system).build());
            messages.addAll(rc.getAgentState().getContext());
            var tools = components.getToolkit().getToolSchemas(rc.getAgentState().getToolContext().getActivatedGroups());
            var input = new ReasoningInput(messages, tools, components.getGenerateOptions());
            var reply = new AtomicReference<ReasoningContext>();
            return chain(ExtensionPoint.ON_REASONING, rc, MiddlewareBase::onReasoning, reasoning ->
                    chain(ExtensionPoint.ON_MODEL_CALL, rc, MiddlewareBase::onModelCall,
                            modelCall -> Flux.defer(() -> {
                                var attempt = new ReasoningContext(components.getName());
                                reply.set(attempt);
                                return modelStream(rc, modelCall, attempt);
                            }))
                            .apply(new ModelCallInput(reasoning.messages(), reasoning.tools(), reasoning.options(),
                                    components.getModel(rc)))).apply(input)
                    .concatWith(Flux.defer(() -> {
                        var attempt = reply.get();
                        Msg result = attempt == null ? null : attempt.buildFinalMessage();
                        return next.apply(result);
                    }));
        });
    }

    private Flux<AgentEvent> modelStream(RuntimeContext rc, ModelCallInput input, ReasoningContext reply) {
        String callId = UUID.randomUUID().toString();
        var preparer = components.getModelRequestPreparer();
        var prepared = preparer == null ? Mono.just(input)
                : preparer.prepare(components, rc, input, callId, ModelRequestPreparer.Purpose.REASONING);
        return prepared.flatMapMany(request -> SessionRecorder.from(rc)
                .prepareModel(request, callId, "REASONING", rc.getAgentState())
                .thenMany(request.model().stream(request.messages(), request.tools(), request.options()))
                .concatMapIterable(chunk -> reply.processChunk(chunk)).<AgentEvent>handle((piece, sink) -> {
                    for (TextBlock text : piece.getContentBlocks(TextBlock.class)) {
                        sink.next(new TextBlockDeltaEvent(callId, "text", text.getText()));
                        break;
                    }
                }));
    }

    Flux<AgentEvent> act(RuntimeContext rc, String replyId, List<ToolUseBlock> calls) {
        return chain(ExtensionPoint.ON_ACTING, rc, MiddlewareBase::onActing,
                input -> Flux.fromIterable(input.toolCalls()).concatMap(call -> execute(rc, replyId, call)))
                .apply(new ActingInput(calls));
    }

    private Flux<AgentEvent> execute(RuntimeContext rc, String replyId, ToolUseBlock call) {
        var journal = SessionRecorder.from(rc);
        var param = ToolCallParam.builder().toolUseBlock(call).agent(components).runtimeContext(rc).build();
        Mono<ToolResultBlock> execution = call.hasMalformedArguments()
                ? Mono.just(ToolResultBlock.error("工具参数不完整，请重新调用。"))
                : components.getToolkit().callTool(param);
        // Providers can reuse tool call IDs across turns. Keep journal IDs intact and scope UI keys to the reply.
        String eventId = replyId + ":" + call.getId();
        return Flux.concat(Flux.just(new ToolCallStartEvent(replyId, eventId, call.getName()),
                        new ToolCallDeltaEvent(replyId, eventId, call.getName(),
                                JsonUtils.getJsonCodec().toJson(call.getInput()))),
                execution.map(result -> result.withIdAndName(call.getId(), call.getName())).flatMapMany(result -> {
                    Msg observation = Msg.builder().role(MsgRole.TOOL).content(result).build();
                    rc.getAgentState().contextMutable().add(observation);
                    String text = result.getOutput().stream().filter(TextBlock.class::isInstance)
                            .map(TextBlock.class::cast).map(TextBlock::getText)
                            .collect(java.util.stream.Collectors.joining("\n"));
                    return journal.checkpoint(rc.getAgentState(), "tool_result")
                            .thenMany(Flux.just(new ToolResultTextDeltaEvent(replyId, eventId, call.getName(), text),
                                    new ToolResultEndEvent(replyId, eventId, call.getName(), result.getState())));
                }));
    }

    private List<MiddlewareBase> hooks(ExtensionPoint point) {
        return middleware.stream().filter(hook -> hook.activePoints() == null || hook.activePoints().contains(point)).toList();
    }

    private <T> Function<T, Flux<AgentEvent>> chain(ExtensionPoint point, RuntimeContext rc,
            MiddlewareChain.MiddlewareMethod<T> method, Function<T, Flux<AgentEvent>> action) {
        return MiddlewareChain.build(hooks(point), components, rc, method, action);
    }
}
