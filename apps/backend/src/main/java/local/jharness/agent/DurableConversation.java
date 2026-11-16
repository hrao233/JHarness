package local.jharness.agent;

import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.event.AgentResultEvent;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.message.ToolUseBlock;
import io.agentscope.core.permission.PermissionContextState;
import io.agentscope.core.permission.PermissionDecision;
import io.agentscope.core.session.SessionInbox;
import io.agentscope.core.session.SessionInteractions;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.session.SessionProjection;
import io.agentscope.core.session.SessionRecovery;
import io.agentscope.core.session.SessionTurns;
import io.agentscope.core.tool.AgentTool;
import io.agentscope.core.tool.ToolBase;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.core.util.JsonUtils;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.session.AgentSession;
import io.agentscope.harness.agent.session.SessionAnswer;
import io.agentscope.harness.agent.tools.ToolsConfig;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;

/**
 * Durable task control plane for desktop conversations.
 *
 * <p>The session log remains the source of truth. Each session has one live
 * {@link AgentSession}, which serializes queued commands and resumed turns. This class maps the
 * session's command and turn identities back to desktop run IDs.
 */
public final class DurableConversation implements AutoCloseable {
    private static final List<String> FILE_TOOLS = List.of(
            "list_files", "read_file", "search_files", "search_text", "edit_file", "create_file",
            "run_command");
    private static final List<String> CONFIRMED_TOOLS = List.of("edit_file", "create_file", "run_command");
    private static final int MAX_TITLE_LENGTH = 96;

    public record Approval(String id, String operation, String path, String before, String after) {}

    public record UncertainCall(String id, String name) {}

    private record ToolCallMetadata(String name, String turnId) {}

    public record TaskView(
            String commandId,
            String turnId,
            String status,
            String title,
            List<Approval> approvals,
            boolean uncertain,
            List<UncertainCall> uncertainCalls) {
        public boolean actionable() {
            return !List.of("completed", "cancelled", "rejected", "failed").contains(status);
        }

        public boolean queued() {
            return status.equals("queued");
        }
    }

    private record TaskLease(SessionRuntime runtime, AgentSession.Task task) {}

    private final Map<String, SessionRuntime> runtimes = new ConcurrentHashMap<>();
    private final Map<String, TaskLease> tasks = new ConcurrentHashMap<>();
    private final ConversationRuntime.Listener listener;
    private final Function<Throwable, String> describeError;

    public DurableConversation(
            ConversationRuntime.Listener listener, Function<Throwable, String> describeError) {
        this.listener = listener;
        this.describeError = describeError;
    }

    /**
     * Accept a submission even while an earlier turn is unfinished. The session runtime owns
     * ordering and keeps the later command queued until the current turn settles.
     */
    public void submit(ConversationRuntime.Request request) throws Exception {
        var runtime = runtime(request);
        String runId = request.context().getRunId();
        synchronized (runtime) {
            runtime.currentRun.compareAndSet(null, runId);
            var task = runtime.session.submit(runId, List.of(request.message()));
            watch(runtime, task, runId);
        }
    }

    public void resume(
            ConversationRuntime.Request request, String turnId, Map<String, Boolean> answers)
            throws Exception {
        var log = ConversationRuntime.openSession(request.workspace(), request.context());
        var pending = requireTask(log, turnId);
        if (pending.uncertain()) throw new IllegalStateException("有工具执行结果待核对，无法续跑此任务。");
        if (!pending.actionable()) throw new IllegalArgumentException("此任务已结束，不能继续。");
        var head = log.head();
        if (head.owner() != null && head.leaseUntil() > System.currentTimeMillis()) {
            throw new IllegalStateException("先前的执行仍持有会话写入权，请稍后重试。");
        }
        var needed = pending.approvals().stream()
                .map(Approval::id)
                .collect(java.util.stream.Collectors.toSet());
        if (!needed.equals(answers.keySet()))
            throw new IllegalArgumentException("请确认本任务的每一项待审批操作。");
        var runtime = runtime(request);
        String runId = request.context().getRunId();
        synchronized (runtime) {
            runtime.currentRun.set(runId);
            AgentSession.Task task;
            if (pending.queued()) {
                task = runtime.session.task(pending.commandId());
                runtime.session.start();
            } else if (answers.isEmpty()) {
                task = runtime.session.resume(turnId);
            } else {
                var responses = new LinkedHashMap<String, SessionAnswer>();
                answers.forEach(
                        (id, allow) -> responses.put(id, new SessionAnswer.Approval(allow, null)));
                task = runtime.session.respond(responses);
            }
            watch(runtime, task, runId);
        }
    }

    /** The command shown for a session navigation entry. A suspended turn outranks a later queue. */
    public static Object task(SessionLog log) {
        return taskList(log).stream()
                .filter(TaskView::actionable)
                .filter(value -> !value.queued() && !value.status().equals("running"))
                .reduce((first, second) -> second)
                .<Object>map(DurableConversation::asMap)
                .orElseGet(Map::of);
    }

    /** Project every execution command into a task view, deduplicated by turn. */
    public static List<TaskView> taskList(SessionLog log) {
        var inbox = new SessionInbox(log).snapshot();
        var turns = SessionTurns.read(log);
        var projection = SessionProjection.read(log);
        var head = log.head();
        boolean liveLease =
                head.owner() != null && head.leaseUntil() > System.currentTimeMillis();
        var commands = new LinkedHashMap<String, SessionInbox.Command>();
        for (var command : inbox.commands()) {
            if (command.execution()) commands.put(command.turnId(), command);
        }
        var result = new ArrayList<TaskView>();
        for (var command : commands.values()) {
            var turn = turns.turns().stream()
                    .filter(value -> value.turnId().equals(command.turnId()))
                    .reduce((first, second) -> second)
                    .orElse(null);
            var approvals = approvals(log, command.turnId());
            boolean started = turns.started().contains(command.id());
            String status;
            if (inbox.rejected().containsKey(command.id())) {
                status = "rejected";
            } else if (!started) {
                status = "queued";
            } else if (turn != null && turn.ended()) {
                status = terminalStatus(turn.status());
            } else if (!approvals.isEmpty()) {
                status = "suspended";
            } else if (liveLease
                    && Objects.equals(head.owner(), turn == null ? null : turn.runId())) {
                status = "running";
            } else {
                status = "interrupted";
            }
            boolean uncertain = !projection.uncertainToolCalls().isEmpty()
                    && !List.of("completed", "cancelled", "rejected").contains(status);
            var uncertainCalls = uncertain
                    ? uncertainCalls(log, command.turnId(), projection.uncertainToolCalls())
                    : List.<UncertainCall>of();
            result.add(new TaskView(
                    command.id(),
                    command.turnId(),
                    status,
                    title(turns.inputs().get(command.turnId())),
                    approvals,
                    uncertain,
                    uncertainCalls));
        }
        return List.copyOf(result);
    }

    public static boolean cancel(SessionLog log, String turnId) {
        var pending = requireTask(log, turnId);
        if (pending.uncertain()) throw new IllegalStateException("有工具执行结果待核对，无法取消此任务。");
        if (!pending.actionable()) throw new IllegalArgumentException("此任务已结束。");
        var latest = SessionTurns.read(log).latest();
        if (latest != null && latest.turnId().equals(turnId) && !latest.ended()) {
            SessionRecovery.cancelPending(log, turnId);
        }
        if (pending.queued()) {
            var command = inboxCommand(log, pending.commandId());
            new SessionInbox(log).locked(tx -> {
                tx.reject(command, "Caller cancelled the queued task");
                return null;
            });
        }
        return true;
    }

    public boolean steer(String runId, String message) {
        if (message == null || message.isBlank() || message.length() > 16000)
            throw new IllegalArgumentException("补充指令需要在 16,000 字符以内。");
        var lease = tasks.get(runId);
        if (lease == null) return false;
        lease.runtime().session.steer(lease.task(), message.strip());
        return true;
    }

    public boolean isActive() {
        return !tasks.isEmpty();
    }

    public void stop(String runId) {
        var lease = tasks.get(runId);
        if (lease == null) return;
        lease.runtime().session.interrupt();
    }

    private SessionRuntime runtime(ConversationRuntime.Request request) throws Exception {
        String sessionId = request.context().getSessionId();
        synchronized (runtimes) {
            var runtime = runtimes.get(sessionId);
            if (runtime == null || runtime.closed.get()) {
                runtime = new SessionRuntime(request);
                runtimes.put(sessionId, runtime);
            }
            return runtime;
        }
    }

    private void watch(SessionRuntime runtime, AgentSession.Task task, String runId) {
        runtime.bind(task, runId);
        var lease = new TaskLease(runtime, task);
        tasks.put(runId, lease);
        runtime.session.await(task).subscribe(
                done -> finish(runId, lease, done.status(), done.error()),
                failure -> finish(runId, lease, "failed", describeError.apply(failure)));
    }

    private void finish(String runId, TaskLease lease, String status, String error) {
        if (tasks.remove(runId, lease)) {
            if (error != null) listener.event(runId, "error", Map.of("message", error));
            listener.event(runId, "done", Map.of("status", status));
        }
        maybeClose(lease.runtime());
    }

    private void maybeClose(SessionRuntime runtime) {
        if (runtime.closed.get()) return;
        boolean leased = tasks.values().stream().anyMatch(value -> value.runtime() == runtime);
        if (leased) return;
        boolean actionable = taskList(runtime.session.log()).stream().anyMatch(TaskView::actionable);
        if (actionable) return;
        synchronized (runtime) {
            if (runtime.closed.compareAndSet(false, true)) {
                runtimes.remove(runtime.sessionId, runtime);
                runtime.closeResources();
            }
        }
    }

    @Override
    public void close() {
        runtimes.values().forEach(SessionRuntime::close);
        runtimes.clear();
        tasks.clear();
    }

    private static SessionInbox.Command inboxCommand(SessionLog log, String commandId) {
        return new SessionInbox(log).snapshot().commands().stream()
                .filter(value -> value.id().equals(commandId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("找不到排队中的任务。"));
    }

    private static TaskView requireTask(SessionLog log, String turnId) {
        return taskList(log).stream()
                .filter(value -> value.turnId().equals(turnId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("此任务已结束或不属于当前会话。"));
    }

    private static List<Approval> approvals(SessionLog log, String turnId) {
        return SessionInteractions.pending(log).entrySet().stream()
                .filter(entry -> turnId.equals(entry.getValue().turnId()))
                .filter(entry -> "confirmation".equals(entry.getValue().data().get("kind")))
                .map(entry -> {
                    var call = JsonUtils.getJsonCodec()
                            .convertValue(entry.getValue().data().get("call"), ToolUseBlock.class);
                    return new Approval(
                            entry.getKey(),
                            call.getName(),
                            text(call, "path"),
                            text(call, "old_text"),
                            call.getName().equals("run_command")
                                    ? text(call, "command")
                                    : text(call, call.getName().equals("edit_file") ? "new_text" : "content"));
                })
                .toList();
    }

    private static String terminalStatus(String status) {
        if (status == null || status.isBlank()) return "completed";
        return switch (status) {
            case "completed", "cancelled", "suspended", "failed", "interrupted" -> status;
            default -> "completed";
        };
    }

    private static String text(ToolUseBlock call, String key) {
        return call.getInput().get(key) instanceof String value ? value : "";
    }

    private static String title(List<Msg> inputs) {
        if (inputs == null) return "";
        for (var input : inputs) {
            String text = input.getTextContent();
            if (input.getMetadata() != null
                    && input.getMetadata().get("jharnessDisplay") instanceof String display)
                text = display;
            text = text == null ? "" : text.replaceAll("\\s+", " ").strip();
            if (!text.isEmpty()) return text.substring(0, Math.min(MAX_TITLE_LENGTH, text.length()));
        }
        return "";
    }

    private static Map<String, Object> asMap(TaskView task) {
        var value = new LinkedHashMap<String, Object>();
        value.put("commandId", task.commandId());
        value.put("turnId", task.turnId());
        value.put("status", task.status());
        value.put("title", task.title());
        value.put("approvals", task.approvals());
        value.put("uncertain", task.uncertain());
        value.put("uncertainCalls", task.uncertainCalls());
        return value;
    }

    public static String toolCallName(SessionLog log, String toolCallId) {
        return toolCall(log, toolCallId).name();
    }

    private static ToolCallMetadata toolCall(SessionLog log, String toolCallId) {
        for (var event : log.scan(0, log.head().seq())) {
            if (!List.of("tool/requested", "tool/dispatch").contains(event.type())) continue;
            var data = event.data();
            if (!toolCallId.equals(String.valueOf(data.get("toolCallId")))) continue;
            Object call = data.get("call");
            if (call != null) {
                var block = JsonUtils.getJsonCodec().convertValue(call, ToolUseBlock.class);
                if (block.getName() != null && !block.getName().isBlank())
                    return new ToolCallMetadata(block.getName(), event.turnId());
            }
            if (data.get("name") instanceof String name && !name.isBlank())
                return new ToolCallMetadata(name, event.turnId());
        }
        return new ToolCallMetadata("tool", null);
    }

    private static List<UncertainCall> uncertainCalls(
            SessionLog log, String turnId, java.util.Set<String> ids) {
        var result = new ArrayList<UncertainCall>();
        for (String id : ids) {
            var call = toolCall(log, id);
            if (call.turnId() == null || call.turnId().equals(turnId))
                result.add(new UncertainCall(id, call.name()));
        }
        return List.copyOf(result);
    }

    private final class SessionRuntime implements AutoCloseable {
        private final String sessionId;
        private final HarnessAgent agent;
        private final AgentSession session;
        private final ProjectCheckpointStore checkpoints;
        private final TaskReportStore reports;
        private final ConversationEvents events;
        private final Disposable subscription;
        private final Map<String, String> runByTurn = new ConcurrentHashMap<>();
        private final AtomicReference<String> currentRun = new AtomicReference<>();
        private final AtomicBoolean closed = new AtomicBoolean();

        private SessionRuntime(ConversationRuntime.Request request) throws Exception {
            sessionId = request.context().getSessionId();
            checkpoints = new ProjectCheckpointStore(request.workspace(), request.project());
            reports = new TaskReportStore(request.workspace());
            var toolkit = new Toolkit();
            request.pluginTools().forEach(toolkit::registerTool);
            toolkit.registerTool(new ProjectTools(
                    request.project(),
                    (operation, path, before, after, denied, action) -> checkpoints.run(
                            sessionId,
                            currentRun.get() == null ? "durable" : currentRun.get(),
                            operation,
                            path,
                            action)));
            toolkit.registerTool(new ProjectCommand(
                    request.project(),
                    (operation, path, before, after, denied, action) -> action.get(),
                    reports,
                    currentRun::get));
            toolkit.registerTool(new AcceptanceCriteriaTool(reports));
            ConversationRuntime.registerArtifactTool(
                    toolkit, request, reports, currentRun::get);
            for (String name : CONFIRMED_TOOLS)
                toolkit.replaceAgentTool(new ConfirmedTool(toolkit.getTool(name)));
            var tools = new ToolsConfig();
            tools.setStrictAllow(true);
            var allowed = new ArrayList<>(FILE_TOOLS);
            allowed.add("deliver_artifact");
            allowed.add("acceptance_write");
            request.pluginTools().forEach(tool -> allowed.add(tool.getName()));
            tools.setAllow(allowed);
            events = new ConversationEvents(
                    ConversationRuntime.MAX_STEPS,
                    (runId, type, data) -> listener.event(runId, type, data),
                    reports,
                    currentRun::set);
            agent = ConversationRuntime.builder(request, toolkit)
                    .toolsConfig(tools)
                    .middleware(events)
                    .build();
            session = agent.session(request.context());
            subscription = session.events().subscribe(this::route);
        }

        private void route(AgentEvent event) {
            if (event instanceof AgentResultEvent result
                    && result.getResult().getTextContent().isBlank()) return;
            String runId = null;
            if (event.getExecution() != null)
                runId = runByTurn.get(event.getExecution().turnId());
            if (runId == null) runId = currentRun.get();
            if (runId != null) currentRun.set(runId);
            if (runId != null) events.publish(runId, event);
        }

        private void bind(AgentSession.Task task, String runId) {
            runByTurn.put(task.turnId(), runId);
            currentRun.compareAndSet(null, runId);
        }

        @Override
        public void close() {
            if (!closed.compareAndSet(false, true)) return;
            closeResources();
        }

        private void closeResources() {
            subscription.dispose();
            agent.close();
        }
    }

    private static final class ConfirmedTool extends ToolBase {
        private final AgentTool delegate;

        ConfirmedTool(AgentTool delegate) {
            super(ToolBase.builder()
                    .name(delegate.getName())
                    .description(delegate.getDescription())
                    .inputSchema(delegate.getParameters())
                    .concurrencySafe(false));
            this.delegate = delegate;
        }

        @Override
        public Mono<PermissionDecision> checkPermissions(
                Map<String, Object> input, PermissionContextState context) {
            return Mono.just(PermissionDecision.ask(
                    delegate.getName().equals("run_command")
                            ? "批准拟运行的项目命令"
                            : "批准拟议的项目文件更改"));
        }

        @Override
        public Mono<ToolResultBlock> callAsync(ToolCallParam param) {
            return delegate.callAsync(param);
        }
    }
}
