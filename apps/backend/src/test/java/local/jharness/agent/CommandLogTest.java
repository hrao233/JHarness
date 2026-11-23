package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.*;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.TextBlock;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

class CommandLogTest {
    @TempDir Path temporary;

    @Test void shortUnicodeOutputRemainsExactEvenAcrossThePreviewBoundary() throws Exception {
        String text = "x".repeat(5999) + "中文🙂" + "y".repeat(5991);
        var data = text.getBytes(StandardCharsets.UTF_8);
        var result = CommandOutput.capture(new ByteArrayInputStream(data), temporary.resolve("out.txt"));
        assertFalse(result.truncated());
        assertEquals(text, result.text());
        assertArrayEquals(data, Files.readAllBytes(temporary.resolve("out.txt")));
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void cancellingALiveProcessLeavesTheExitCodeUnknown() throws Exception {
        var reports = new TaskReportStore(temporary.resolve("workspace"));
        var tool = new ProjectCommand(temporary, (op, path, before, after, denied, action) -> action.get(),
                reports, () -> "run");
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            var execution = executor.submit(() -> tool.run(
                    RuntimeContext.builder().userId("user").sessionId("session").build(),
                    "Set-Content started.txt ready; Start-Sleep -Seconds 60"));
            Path started = temporary.resolve("started.txt");
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
            while (!Files.exists(started) && System.nanoTime() < deadline) Thread.sleep(50);
            assertTrue(Files.exists(started));
            tool.close();
            execution.get(10, java.util.concurrent.TimeUnit.SECONDS);
            var receipt = reports.reports("session", List.of()).get(0).commands().get(0);
            assertNull(receipt.exitCode());
            assertEquals(TaskReportStore.CommandOutcome.UNKNOWN, receipt.outcome());
        } finally {
            tool.close();
            executor.shutdownNow();
        }
    }

    @Test @EnabledOnOs(OS.WINDOWS)
    void failedBuildKeepsTheFirstAndLastOutputAndOnlyFreshTestFailures() throws Exception {
        Path project = Files.createDirectory(temporary.resolve("project"));
        Path dir = Files.createDirectories(project.resolve("target/surefire-reports"));
        String xml = "<testsuite><testcase classname='Example' name='broken'><failure message='expected 42'/></testcase></testsuite>";
        Files.writeString(dir.resolve("TEST-Stale.xml"), xml.replace("broken", "stale"));
        Files.writeString(project.resolve("fixture.xml"), xml);
        Files.writeString(project.resolve("mvnw.cmd"), "@echo off\r\ncopy /y fixture.xml target\\surefire-reports\\TEST-Example.xml >nul\r\nexit /b 7\r\n");
        String command = "Write-Output ('FIRST' + ('a' * 9000) + 'ONLY-IN-LOG' + ('b' * 9000) + 'LAST'); .\\mvnw.cmd; exit $LASTEXITCODE";
        var reports = new TaskReportStore(temporary.resolve("workspace"));
        var tool = new ProjectCommand(project, (op, path, before, after, denied, action) -> action.get(), reports, () -> "run");
        var result = tool.run(RuntimeContext.builder().userId("user").sessionId("session").build(), command);
        String preview = ((TextBlock) result.getOutput().get(0)).getText();
        assertTrue(preview.contains("FIRST") && preview.contains("LAST"));
        assertFalse(preview.contains("ONLY-IN-LOG"));
        assertTrue(preview.contains("Example#broken"));
        assertFalse(preview.contains("Example#stale"));
        var receipt = reports.reports("session", List.of()).get(0).commands().get(0);
        assertEquals(7, receipt.exitCode());
        assertEquals(1, receipt.testFailures().size());
        assertTrue(receipt.testFailures().get(0).contains("Example#broken"));
        assertTrue(receipt.output().contains("LAST") && receipt.output().contains("expected 42"));
        var reopened = new TaskReportStore(temporary.resolve("workspace"));
        String raw = Files.readString(Path.of(reopened.commandLog("session", "run", receipt.id())));
        assertEquals("FIRST" + "a".repeat(9000) + "ONLY-IN-LOG" + "b".repeat(9000) + "LAST", raw.stripTrailing());
        assertThrows(IllegalArgumentException.class, () -> reopened.commandLog("other", "run", receipt.id()));
    }
}
