package local.jharness.agent;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.ToolExecutionDetails;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

public final class ProjectCommand {
    private record Receipt(String session, String run, String id) {}
    private final Path project;
    private final ApprovedOperation approval;
    private final TaskReportStore reports;
    private final Supplier<String> activeRunId;
    private boolean closed;
    private Process running;

    ProjectCommand(
            Path project,
            ApprovedOperation approval,
            TaskReportStore reports,
            Supplier<String> activeRunId) {
        this.project = project;
        this.approval = approval;
        this.reports = reports;
        this.activeRunId = activeRunId;
    }

    @Tool(name = "run_command", description = """
            Run a non-interactive Windows PowerShell command from the project directory after
            the user approves it. Use for requested builds, tests and Git inspection.
            Returns combined output and exit status. Commands have a two-minute timeout.
            """, concurrencySafe = false)
    public ToolResultBlock run(
            RuntimeContext context,
            @ToolParam(name = "command", description = "Exact PowerShell command to show and run")
                    String command) {
        if (command == null || command.isBlank() || command.indexOf(0) >= 0 || command.length() > 8000) {
            return ToolResultBlock.error("请输入 8,000 字符以内的有效 PowerShell 命令。");
        }
        return approval.run("run_command", project.toString(), "", command, "命令未获批准，未执行。",
                () -> runApproved(context, command));
    }

    private ToolResultBlock runApproved(RuntimeContext context, String command) {
        long startedAt = System.currentTimeMillis();
        String run = activeRunId.get();
        if ((run == null || run.isBlank()) && context != null) run = context.getRunId();
        Receipt receipt = context == null || context.getSessionId() == null || run == null ? null
                : new Receipt(context.getSessionId(), run, UUID.randomUUID().toString());
        Path log = receipt == null ? null : reports.logPath(receipt.session(), receipt.run(), receipt.id());
        Process process = null;
        try {
            var tests = SurefireFailures.beforeCommand(project, command);
            synchronized (this) {
                if (closed) {
                    return evidence(
                            receipt,
                            command,
                            startedAt,
                            null,
                            ToolExecutionDetails.Outcome.UNKNOWN,
                            false, false, List.of(),
                            ToolResultBlock.error("任务已停止，命令未执行。"));
                }
                String shell = Path.of(System.getenv("SystemRoot"), "System32", "WindowsPowerShell",
                        "v1.0", "powershell.exe").toString();
                String script = "$ProgressPreference = 'SilentlyContinue'\n"
                        + "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n"
                        + command;
                String encoded = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
                var builder = new ProcessBuilder(shell, "-NoLogo", "-NoProfile", "-NonInteractive",
                        "-EncodedCommand", encoded)
                        .directory(project.toFile()).redirectErrorStream(true);
                process = builder.start();
                running = process;
            }
            process.getOutputStream().close();
            Process started = process;
            var output = new FutureTask<>(() -> CommandOutput.capture(started.getInputStream(), log));
            var reader = new Thread(output, "jharness-command-output");
            reader.setDaemon(true);
            reader.start();
            boolean timedOut = !process.waitFor(2, TimeUnit.MINUTES);
            if (timedOut) stopProcess(process);
            CommandOutput captured;
            try {
                captured = output.get(2, TimeUnit.SECONDS);
            } catch (TimeoutException error) {
                captured = new CommandOutput("子进程仍占用输出，无法取得完整结果。", true, false);
            }
            if (timedOut) {
                return evidence(receipt, command, startedAt, null, ToolExecutionDetails.Outcome.UNKNOWN,
                        true, captured.logComplete(), List.of(), ToolResultBlock.error("命令超过两分钟，已停止。\n" + captured.text()));
            }
            int code = process.exitValue();
            String result = "退出码 " + code + "\n" + captured.text();
            if (captured.truncated()) {
                result += captured.logComplete() ? "\n完整日志已保存到任务报告。" : "\n完整日志未能保存。";
            }
            List<String> failures = code != 0 && tests != null ? tests.failures() : List.of();
            if (!failures.isEmpty()) result += "\n本次构建期间更新的 Surefire 报告（最多 10 项）\n" + String.join("\n", failures);
            ToolExecutionDetails.Outcome outcome = code == 0
                    ? ToolExecutionDetails.Outcome.SUCCEEDED
                    : ToolExecutionDetails.Outcome.FAILED;
            ToolResultBlock block = code == 0
                    ? ToolResultBlock.success(result)
                    : ToolResultBlock.error(result);
            return evidence(
                    receipt,
                    command,
                    startedAt,
                    code,
                    outcome,
                    captured.truncated(), captured.logComplete(), failures,
                    block);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return evidence(
                    receipt,
                    command,
                    startedAt,
                    null,
                    ToolExecutionDetails.Outcome.UNKNOWN,
                    false, false, List.of(),
                    ToolResultBlock.error("命令已取消。"));
        } catch (IOException | ExecutionException error) {
            return evidence(
                    receipt,
                    command,
                    startedAt,
                    null,
                    ToolExecutionDetails.Outcome.UNKNOWN,
                    false, false, List.of(),
                    ToolResultBlock.error("无法执行 PowerShell 命令或读取输出。"));
        } finally {
            synchronized (this) {
                if (process != null) {
                    if (process.isAlive()) stopProcess(process);
                    if (running == process) running = null;
                    try { process.getInputStream().close(); } catch (IOException ignored) { }
                }
            }
        }
    }

    synchronized void close() {
        closed = true;
        if (running != null && running.isAlive()) stopProcess(running);
    }

    private static void stopProcess(Process process) {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
    }

    private ToolResultBlock evidence(
            Receipt receipt,
            String command,
            long startedAt,
            Integer exitCode,
            ToolExecutionDetails.Outcome outcome,
            boolean truncated, boolean logComplete, List<String> failures,
            ToolResultBlock block) {
        var result = block.withExecutionDetails(
                new ToolExecutionDetails("shell", outcome, exitCode, truncated));
        if (receipt != null) {
            try {
                reports.recordCommand(
                        receipt.id(), logComplete, failures, receipt.session(), receipt.run(),
                        command,
                        startedAt,
                        System.currentTimeMillis(),
                        exitCode,
                        outcome.name(),
                        truncated,
                        result.getOutput().stream()
                                .map(item -> item instanceof io.agentscope.core.message.TextBlock text
                                        ? text.getText()
                                        : "")
                                .reduce("", String::concat));
            } catch (RuntimeException ignored) {
                // A reporting failure must not turn an already executed command into a retry.
            }
        }
        return result;
    }

}
