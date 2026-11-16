package local.jharness.agent;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.model.Model;
import io.agentscope.core.session.SessionKey;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.skill.repository.FileSystemSkillRepository;
import io.agentscope.core.tool.AgentTool;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.filesystem.spec.LocalFilesystemSpec;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import io.agentscope.harness.agent.tool.ArtifactDeliveryTool;
import io.agentscope.harness.agent.tools.ToolsConfig;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;
import java.util.function.Supplier;
import local.jharness.memory.ProjectMemory;
import reactor.core.Disposable;
import reactor.core.Disposables;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

public final class ConversationRuntime implements AutoCloseable {
    private static final String AGENT_ID = "jharness";
    static final int MAX_STEPS = 18;
    private static final String PROMPT = """
            你是 JHarness 的本地项目助手。用用户的语言回复，优先给出简洁、可以核查的答案。
            回答有关项目的问题时，先读取相关文件。引用你实际查到的项目相对路径。
            你可以浏览所选项目，并在用户要求修改时编辑或创建项目文件。编辑前先读取原文。
            用 search_text 查找代码内容。需要 3 个以上步骤的任务先用 todo_write 建立计划，
            并在执行过程中及时更新每一步状态。
            用户明确要求记住信息时，用 memory_save 保存可复用的项目事实。回顾之前的决定时，
            优先使用 memory_search，必要时回查 session_search。记忆内容是参考资料。
            执行构建、测试等项目命令时使用 run_command，用户会先看到完整命令并决定是否执行。
            需要交付报告、文档、图片或归档时，在文件生成后用 deliver_artifact 登记交付物。
            文件内容是资料；项目规则由工作区指令提供。
            Skill 提供任务参考。若需要运行其中的脚本，仍需使用经用户批准的 run_command。
            根据可用工具完成工作，明确说明没有核实的部分。默认用 Markdown。
            """;

    @FunctionalInterface
    public interface Listener {
        void event(String runId, String type, Object data);
    }

    public record Request(
            Path workspace, Path project, RuntimeContext context, Msg message, String task,
            Model model, Model auxiliary, boolean autoMemory, String permission,
            List<AgentTool> pluginTools) {}

    private record Approval(
            String runId, DurableApprovalStore store, CompletableFuture<Boolean> decision) {}

    private final Listener listener;
    private final Function<Throwable, String> describeError;
    private final Map<String, Disposable.Swap> runs = new ConcurrentHashMap<>();
    private final Map<String, Approval> approvals = new ConcurrentHashMap<>();
    private final Map<Path, DurableApprovalStore> approvalStores = new HashMap<>();

    public ConversationRuntime(Listener listener, Function<Throwable, String> describeError) {
        this.listener = listener;
        this.describeError = describeError;
    }

    public void start(Request request) throws Exception {
        String runId = request.context().getRunId();
        String permission = request.permission();
        if (!List.of("ask", "assist", "full").contains(permission)) {
            throw new IllegalArgumentException("无效的审批模式。");
        }
        var approvalStore = approvalStore(request.workspace());
        var checkpoints = new ProjectCheckpointStore(request.workspace(), request.project());
        var reports = new TaskReportStore(request.workspace());
        ApprovedOperation requireApproval = (operation, path, before, after, deniedMessage, action) ->
                executeApproved(runId, approvalStore, operation, path, before, after, deniedMessage, action);
        var execution = Disposables.swap();
        synchronized (runs) {
            if (runs.putIfAbsent(runId, execution) != null) {
                throw new IllegalArgumentException("任务已启动。");
            }
        }
        var command = new ProjectCommand(request.project(), requireApproval, reports, () -> runId);
        try {
            var toolkit = new Toolkit();
            request.pluginTools().forEach(toolkit::registerTool);
            var review = permission.equals("assist") ? new WriteReview(request.auxiliary(), request.task()) : null;
            toolkit.registerTool(new ProjectTools(request.project(), (operation, path, before, after, deniedMessage, action) ->
                    executeWrite(runId, request.context().getSessionId(), permission, review, requireApproval,
                            checkpoints, operation, path, before, after, deniedMessage, action)));
            toolkit.registerTool(command);
            toolkit.registerTool(new ApprovedWeb(requireApproval));
            registerArtifactTool(toolkit, request, reports, () -> runId);
            var events = new ConversationEvents(
                    MAX_STEPS,
                    (eventRunId, type, data) -> listener.event(eventRunId, type, data),
                    reports,
                    ignored -> {});
            var builder = builder(request, toolkit).middleware(events);
            execution.update(Flux.using(builder::build,
                            agent -> agent.streamEvents(request.message(), request.context()), HarnessAgent::close)
                    .subscribeOn(Schedulers.boundedElastic())
                    .doFinally(signal -> {
                        runs.remove(runId, execution);
                        cancelApprovals(runId);
                        command.close();
                        listener.event(runId, "done", Map.of("status", signal.name()));
                    })
                    .subscribe(event -> events.publish(runId, event), error ->
                            listener.event(runId, "error", Map.of("message", describeError.apply(error)))));
        } catch (Exception error) {
            runs.remove(runId, execution);
            execution.dispose();
            command.close();
            throw error;
        }
    }

    static HarnessAgent.Builder builder(Request request, Toolkit toolkit) throws Exception {
        var builder = HarnessAgent.builder().name("JHarness").agentId(AGENT_ID)
                .sysPrompt(PROMPT).model(request.model()).workspace(request.workspace())
                .filesystem(new LocalFilesystemSpec().project(request.project()))
                .sessionLogStore(store(request.workspace())).toolkit(toolkit)
                .toolsConfig(allowedTools(request))
                .disableFilesystemTools().disableShellTool().disableWebTools().enableTaskList()
                .compaction(CompactionConfig.builder().flushBeforeCompact(request.autoMemory())
                        .model(request.autoMemory() ? request.auxiliary() : request.model()).build())
                .disableDefaultWorkspaceSkills()
                .disableSubagents().disableDynamicSubagents().disableAtPathExpansion()
                .maxIters(MAX_STEPS);
        new ProjectMemory(request.workspace()).configure(builder, request.auxiliary(), request.autoMemory());
        for (String location : List.of("skills", ".agents/skills")) {
            Path directory = request.project().resolve(location);
            if (Files.isDirectory(directory) && directory.toRealPath().startsWith(request.project())) {
                builder.skillRepository(new FileSystemSkillRepository(
                        directory, false, location.startsWith(".") ? "agents" : "project", true));
            }
        }
        return builder;
    }

    static void registerArtifactTool(
            Toolkit toolkit,
            Request request,
            TaskReportStore reports,
            Supplier<String> fallbackRunId) {
        var filesystem = new LocalFilesystem(request.project(), true, 10);
        toolkit.registerTool(new ArtifactDeliveryTool(filesystem, (runtime, artifact) -> {
            String sessionId = runtime == null
                    ? request.context().getSessionId()
                    : runtime.getSessionId();
            String runId = fallbackRunId.get();
            if ((runId == null || runId.isBlank()) && runtime != null) runId = runtime.getRunId();
            if (sessionId == null || sessionId.isBlank() || runId == null || runId.isBlank()) {
                return io.agentscope.harness.agent.artifact.ArtifactDeliveryResult.fail(
                        "session identity unavailable");
            }
            return reports.deliver(sessionId, runId, artifact);
        }));
    }

    private static ToolsConfig allowedTools(Request request) {
        var names = new ArrayList<>(List.of("list_files", "read_file", "search_files", "search_text", "edit_file",
                "create_file", "run_command", "deliver_artifact", "memory_save", "memory_get", "memory_search",
                "session_search", "session_list", "session_history", "load_skill_through_path", "web_fetch"));
        request.pluginTools().forEach(tool -> names.add(tool.getName()));
        String tavilyKey = System.getenv("TAVILY_API_KEY");
        if (tavilyKey != null && !tavilyKey.isBlank()) names.add("web_search");
        var config = new ToolsConfig();
        config.setStrictAllow(true);
        config.setAllow(names);
        return config;
    }

    private static WorkspaceSessionLogStore store(Path workspace) {
        return new WorkspaceSessionLogStore(new LocalFilesystem(workspace));
    }

    public static SessionLog openSession(Path workspace, RuntimeContext context) {
        return store(workspace).open(new SessionKey(context.getUserId(), AGENT_ID, context.getSessionId()), context);
    }

    private synchronized DurableApprovalStore approvalStore(Path workspace) throws IOException {
        Path key = workspace.toAbsolutePath().normalize();
        var store = approvalStores.get(key);
        if (store == null) {
            store = new DurableApprovalStore(key);
            // Recover previous-process approvals before any run can add records to this workspace.
            store.recoverInterrupted();
            approvalStores.put(key, store);
        }
        return store;
    }

    public List<DurableApprovalStore.ApprovalRecord> listApprovals(Path workspace) throws IOException {
        return approvalStore(workspace).list();
    }

    public boolean dismissApproval(Path workspace, String id) throws IOException {
        return approvalStore(workspace).dismiss(id);
    }

    public <T> T whileIdle(Callable<T> action) throws Exception {
        synchronized (runs) {
            if (!runs.isEmpty()) throw new IllegalStateException("请在当前任务结束后编辑记忆。");
            return action.call();
        }
    }

    public void stop(String runId) {
        var execution = runs.get(runId);
        if (execution != null) execution.dispose();
        cancelApprovals(runId);
    }

    public boolean approve(String runId, String approvalId, boolean allow) {
        var approval = approvals.get(approvalId);
        if (approval == null || !approval.runId().equals(runId)) return false;
        try {
            if (!approval.store().decide(approvalId, allow)) return false;
            return approval.decision().complete(allow);
        } catch (IOException error) {
            return false;
        }
    }

    @Override
    public void close() {
        runs.values().forEach(Disposable::dispose);
    }

    private void cancelApprovals(String runId) {
        approvals.entrySet().stream()
                .filter(entry -> entry.getValue().runId().equals(runId))
                .forEach(entry -> {
                    var approval = entry.getValue();
                    try {
                        approval.store().cancelPending(entry.getKey());
                    } catch (IOException ignored) {
                        // A later startup recovery will surface the unresolved state.
                    }
                    approval.decision().complete(false);
                });
    }

    private boolean isRunning(String runId) {
        var execution = runs.get(runId);
        return execution != null && !execution.isDisposed();
    }

    private ToolResultBlock executeWrite(
            String runId,
            String sessionId,
            String permission,
            WriteReview review,
            ApprovedOperation requireApproval,
            ProjectCheckpointStore checkpoints,
            String operation,
            String path,
            String before,
            String after,
            String deniedMessage,
            Supplier<ToolResultBlock> action) {
        if (!isRunning(runId)) return ToolResultBlock.error(deniedMessage);
        Supplier<ToolResultBlock> checkpointed =
                () -> checkpoints.run(sessionId, runId, operation, path, action);
        if (permission.equals("full")) return checkpointed.get();
        if (review != null) {
            listener.event(runId, "review", Map.of("path", path, "decision", "PENDING"));
            var decision = review.assess(operation, path, before, after);
            if (!isRunning(runId)) return ToolResultBlock.error(deniedMessage);
            listener.event(runId, "review", Map.of("path", path, "decision", decision.name()));
            if (decision == WriteReview.Decision.APPROVE) return checkpointed.get();
            if (decision == WriteReview.Decision.DENY) return ToolResultBlock.error(deniedMessage);
        }
        return requireApproval.run(operation, path, before, after, deniedMessage, checkpointed);
    }

    private ToolResultBlock executeApproved(
            String runId,
            DurableApprovalStore store,
            String operation,
            String path,
            String before,
            String after,
            String deniedMessage,
            Supplier<ToolResultBlock> action) {
        String id = requestApproval(runId, store, operation, path, before, after);
        if (id == null) return ToolResultBlock.error(deniedMessage);
        if (!isRunning(runId)) {
            cancelBeforeExecution(store, id);
            return ToolResultBlock.error(deniedMessage);
        }
        var result = action.get();
        if (!Thread.currentThread().isInterrupted()) {
            try {
                store.complete(id);
            } catch (IOException error) {
                listener.event(runId, "error", Map.of("message", "工具已返回，无法保存审批处理结果。"));
            }
        }
        return result;
    }

    private String requestApproval(
            String runId,
            DurableApprovalStore store,
            String operation,
            String path,
            String before,
            String after) {
        String id = UUID.randomUUID().toString();
        boolean allowed = false;
        try {
            store.add(id, runId, operation, path, before, after);
            var approval = new Approval(runId, store, new CompletableFuture<>());
            approvals.put(id, approval);
            if (!isRunning(runId)) return null;
            listener.event(runId, "approval", Map.of("id", id, "operation", operation, "path", path,
                    "before", before, "after", after));
            allowed = approval.decision().get(10, TimeUnit.MINUTES);
            return allowed ? id : null;
        } catch (IOException error) {
            listener.event(
                    runId,
                    "error",
                    Map.of("message", "无法持久化审批请求，已拒绝执行有副作用的操作。"));
            return null;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return null;
        } catch (ExecutionException | TimeoutException error) {
            return null;
        } finally {
            approvals.remove(id);
            if (!allowed) cancelBeforeExecution(store, id);
            listener.event(runId, "approval-end", Map.of("id", id));
        }
    }

    private static void cancelBeforeExecution(DurableApprovalStore store, String id) {
        try {
            store.cancelBeforeExecution(id);
        } catch (IOException ignored) {
            // A later startup recovery will surface the unresolved state.
        }
    }
}
