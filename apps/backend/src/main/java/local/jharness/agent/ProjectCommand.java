package local.jharness.agent;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.ToolExecutionDetails;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

public final class ProjectCommand {
    private static final int MAX_OUTPUT_BYTES = 12000;
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
        Process process = null;
        try {
            synchronized (this) {
                if (closed) {
                    return evidence(
                            context,
                            command,
                            startedAt,
                            null,
                            ToolExecutionDetails.Outcome.UNKNOWN,
                            false,
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
            var output = new FutureTask<>(() -> readOutput(started));
            var reader = new Thread(output, "jharness-command-output");
            reader.setDaemon(true);
            reader.start();
            if (!process.waitFor(2, TimeUnit.MINUTES)) {
                return evidence(
                        context,
                        command,
                        startedAt,
                        null,
                        ToolExecutionDetails.Outcome.UNKNOWN,
                        true,
                        ToolResultBlock.error("命令超过两分钟，已停止等待。"));
            }
            int code = process.exitValue();
            CapturedOutput captured;
            try {
                captured = output.get(2, TimeUnit.SECONDS);
            } catch (TimeoutException error) {
                captured = new CapturedOutput("子进程仍占用输出，无法取得完整结果。", true);
            }
            String result = "退出码 " + code + "\n" + captured.text();
            ToolExecutionDetails.Outcome outcome = code == 0
                    ? ToolExecutionDetails.Outcome.SUCCEEDED
                    : ToolExecutionDetails.Outcome.FAILED;
            ToolResultBlock block = code == 0
                    ? ToolResultBlock.success(result)
                    : ToolResultBlock.error(result);
            return evidence(
                    context,
                    command,
                    startedAt,
                    code,
                    outcome,
                    captured.truncated(),
                    block);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return evidence(
                    context,
                    command,
                    startedAt,
                    null,
                    ToolExecutionDetails.Outcome.UNKNOWN,
                    false,
                    ToolResultBlock.error("命令已取消。"));
        } catch (IOException | ExecutionException error) {
            return evidence(
                    context,
                    command,
                    startedAt,
                    null,
                    ToolExecutionDetails.Outcome.UNKNOWN,
                    false,
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
            RuntimeContext context,
            String command,
            long startedAt,
            Integer exitCode,
            ToolExecutionDetails.Outcome outcome,
            boolean truncated,
            ToolResultBlock block) {
        var result = block.withExecutionDetails(
                new ToolExecutionDetails("shell", outcome, exitCode, truncated));
        String runId = activeRunId.get();
        if (runId == null || runId.isBlank()) {
            runId = context == null ? null : context.getRunId();
        }
        if (context != null && context.getSessionId() != null && runId != null) {
            try {
                reports.recordCommand(
                        context.getSessionId(),
                        runId,
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

    private static CapturedOutput readOutput(Process process) throws IOException {
        try (var input = process.getInputStream(); var captured = new ByteArrayOutputStream()) {
            var buffer = new byte[4096];
            boolean truncated = false;
            int read;
            while ((read = input.read(buffer)) != -1) {
                int keep = Math.min(read, MAX_OUTPUT_BYTES - captured.size());
                captured.write(buffer, 0, keep);
                if (keep < read) truncated = true;
            }
            return new CapturedOutput(
                    captured.toString(StandardCharsets.UTF_8)
                            + (truncated ? "\n[输出已截断]" : ""),
                    truncated);
        }
    }

    private record CapturedOutput(String text, boolean truncated) {}
}
