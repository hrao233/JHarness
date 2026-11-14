package local.jharness;

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
import java.util.function.Predicate;

public final class ProjectCommand {
    private static final int MAX_OUTPUT_BYTES = 12000;
    private final Path project;
    private final Predicate<String> approve;
    private boolean closed;
    private Process running;

    ProjectCommand(Path project, Predicate<String> approve) {
        this.project = project;
        this.approve = approve;
    }

    @Tool(name = "run_command", description = """
            Run a non-interactive Windows PowerShell command from the project directory after
            the user approves it. Use for requested builds, tests and Git inspection.
            Returns combined output and exit status. Commands have a two-minute timeout.
            """, concurrencySafe = false)
    public ToolResultBlock run(@ToolParam(name = "command", description = "Exact PowerShell command to show and run")
            String command) {
        if (command == null || command.isBlank() || command.indexOf(0) >= 0 || command.length() > 8000) {
            return ToolResultBlock.error("请输入 8,000 字符以内的有效 PowerShell 命令。");
        }
        if (!approve.test(command)) return ToolResultBlock.error("命令未获批准，未执行。");
        Process process = null;
        try {
            synchronized (this) {
                if (closed) return ToolResultBlock.error("任务已停止，命令未执行。");
                String shell = Path.of(System.getenv("SystemRoot"), "System32", "WindowsPowerShell",
                        "v1.0", "powershell.exe").toString();
                String script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" + command;
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
                return ToolResultBlock.error("命令超过两分钟，已停止等待。");
            }
            int code = process.exitValue();
            String text;
            try {
                text = output.get(2, TimeUnit.SECONDS);
            } catch (TimeoutException error) {
                text = "子进程仍占用输出，无法取得完整结果。";
            }
            String result = "退出码 " + code + "\n" + text;
            return code == 0 ? ToolResultBlock.success(result) : ToolResultBlock.error(result);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return ToolResultBlock.error("命令已取消。");
        } catch (IOException | ExecutionException error) {
            return ToolResultBlock.error("无法执行 PowerShell 命令或读取输出。");
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

    private static String readOutput(Process process) throws IOException {
        try (var input = process.getInputStream(); var captured = new ByteArrayOutputStream()) {
            var buffer = new byte[4096];
            boolean truncated = false;
            int read;
            while ((read = input.read(buffer)) != -1) {
                int keep = Math.min(read, MAX_OUTPUT_BYTES - captured.size());
                captured.write(buffer, 0, keep);
                if (keep < read) truncated = true;
            }
            return captured.toString(StandardCharsets.UTF_8) + (truncated ? "\n[输出已截断]" : "");
        }
    }
}
