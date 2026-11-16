package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.harness.agent.artifact.ArtifactDeliveryRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TaskReportStoreTest {
    @TempDir Path temporary;

    @Test
    void persistsPlanCommandArtifactAndCheckpointInOneTaskReport() throws Exception {
        Path project = Files.createDirectories(temporary.resolve("project"));
        Path workspace = Files.createDirectories(temporary.resolve("workspace"));
        String sessionId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        var reports = new TaskReportStore(workspace);

        var first = reports.savePlan(
                sessionId,
                runId,
                List.of(
                        new TaskReportStore.PlanStep("读取项目", "completed", "high"),
                        new TaskReportStore.PlanStep("运行测试", "in_progress", "medium")));
        var second = reports.savePlan(
                sessionId,
                runId,
                List.of(
                        new TaskReportStore.PlanStep("读取项目", "completed", "high"),
                        new TaskReportStore.PlanStep("运行测试", "completed", "medium")));
        assertEquals(1, first.revision());
        assertEquals(2, second.revision());

        var command = reports.recordCommand(
                sessionId,
                runId,
                "mvn test",
                System.currentTimeMillis() - 120,
                System.currentTimeMillis(),
                0,
                "SUCCEEDED",
                false,
                "BUILD SUCCESS");
        assertEquals(TaskReportStore.CommandOutcome.SUCCEEDED, command.outcome());
        assertTrue(command.durationMs() >= 120);

        Path artifactSource = project.resolve("report.md");
        Files.writeString(artifactSource, "# Result", StandardCharsets.UTF_8);
        var artifact = reports.saveArtifact(
                sessionId,
                runId,
                new ArtifactDeliveryRequest(
                        "report.md",
                        Files.readAllBytes(artifactSource),
                        "result.md",
                        "Test result",
                        false));
        assertEquals(8, artifact.size());
        assertTrue(Files.isRegularFile(Path.of(artifact.filePath())));
        assertEquals(artifact, reports.artifact(sessionId, artifact.id()));

        Path note = project.resolve("note.txt");
        Files.writeString(note, "BEFORE", StandardCharsets.UTF_8);
        var checkpoints = new ProjectCheckpointStore(workspace, project);
        checkpoints.run(sessionId, runId, "edit_file", "note.txt", () -> {
            writeUnchecked(note, "AFTER");
            return ToolResultBlock.success("edited");
        });
        var summaries = checkpoints.list(sessionId);

        var report = reports.reports(sessionId, summaries).get(0);
        assertEquals(runId, report.runId());
        assertEquals(2, report.plan().revision());
        assertEquals(List.of("completed", "completed"),
                report.plan().steps().stream().map(TaskReportStore.PlanStep::status).toList());
        assertEquals(1, report.commands().size());
        assertEquals(1, report.artifacts().size());
        assertEquals(1, report.checkpoints().size());
    }

    @Test
    void isolatesRunsAndPreventsAccidentalArtifactOverwrite() throws Exception {
        Path workspace = Files.createDirectories(temporary.resolve("workspace-two"));
        String sessionId = UUID.randomUUID().toString();
        String firstRun = UUID.randomUUID().toString();
        String secondRun = UUID.randomUUID().toString();
        var reports = new TaskReportStore(workspace);
        reports.savePlan(
                sessionId,
                firstRun,
                List.of(new TaskReportStore.PlanStep("First", "pending", "")));
        reports.savePlan(
                sessionId,
                secondRun,
                List.of(new TaskReportStore.PlanStep("Second", "in_progress", "high")));
        assertEquals("First", reports.plan(sessionId, firstRun).steps().get(0).content());
        assertEquals("Second", reports.plan(sessionId, secondRun).steps().get(0).content());

        var request = new ArtifactDeliveryRequest(
                "output.txt",
                "VERSION-ONE".getBytes(StandardCharsets.UTF_8),
                "output.txt",
                "First version",
                false);
        var delivered = reports.deliver(sessionId, firstRun, request);
        assertTrue(delivered.successful());
        assertFalse(delivered.conflict());

        var conflict = reports.deliver(sessionId, firstRun, request);
        assertFalse(conflict.successful());
        assertTrue(conflict.conflict());

        var forced = reports.deliver(
                sessionId,
                firstRun,
                new ArtifactDeliveryRequest(
                        "output.txt",
                        "VERSION-TWO".getBytes(StandardCharsets.UTF_8),
                        "output.txt",
                        "Replacement",
                        true));
        assertTrue(forced.successful());
        var artifact = reports.reports(sessionId, List.of()).get(0).artifacts().get(0);
        assertEquals("VERSION-TWO", Files.readString(Path.of(artifact.filePath())));

        assertThrows(IllegalArgumentException.class,
                () -> reports.savePlan("../outside", firstRun, List.of()));
        assertThrows(IllegalArgumentException.class,
                () -> reports.reports("../outside", List.of()));
        assertEquals(2, reports.reports(sessionId, List.of()).size());
    }

    private static void writeUnchecked(Path file, String text) {
        try {
            Files.writeString(file, text, StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
