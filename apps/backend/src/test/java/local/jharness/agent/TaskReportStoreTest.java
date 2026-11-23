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

    @Test
    void verifiesAcceptanceOnlyFromDeterministicShellEvidence() throws Exception {
        Path workspace = Files.createDirectories(temporary.resolve("workspace-acceptance"));
        String sessionId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        var reports = new TaskReportStore(workspace);
        var acceptance = reports.saveAcceptanceCriteria(
                sessionId,
                runId,
                List.of("Automated test command exits successfully", "Second criterion"));
        assertEquals(2, acceptance.criteria().size());
        assertEquals(TaskReportStore.CriterionStatus.PENDING,
                acceptance.criteria().get(0).status());

        long now = System.currentTimeMillis();
        var passedCommand = reports.recordCommand(
                sessionId, runId, "mvn test", now, now + 10, 0, "SUCCEEDED", false, "BUILD SUCCESS");
        var verified = reports.verifyCriterion(
                sessionId,
                runId,
                acceptance.criteria().get(0).id(),
                passedCommand.id(),
                0);
        assertEquals(TaskReportStore.CriterionStatus.PASSED, verified.status());
        assertEquals("shell-exit-v1:0", verified.verifier());

        var truncatedCommand = reports.recordCommand(
                sessionId, runId, "large output", now, now + 20, 0, "SUCCEEDED", true, "truncated");
        var truncatedExit = reports.verifyCriterion(
                sessionId,
                runId,
                acceptance.criteria().get(1).id(),
                truncatedCommand.id(),
                0);
        assertEquals(TaskReportStore.CriterionStatus.PASSED, truncatedExit.status());
        var interrupted = reports.recordCommand(
                sessionId, runId, "interrupted", now, now + 20, null, "UNKNOWN", true, "");
        var inconsistent = reports.recordCommand(
                sessionId, runId, "bad receipt", now, now + 20, 0, "FAILED", true, "");
        for (var incomplete : List.of(interrupted, inconsistent)) {
            assertEquals(TaskReportStore.CriterionStatus.UNKNOWN, reports.verifyCriterion(sessionId,
                    runId, truncatedExit.id(), incomplete.id(), 0).status());
        }

        var failedCommand = reports.recordCommand(
                sessionId, runId, "mvn test", now, now + 30, 1, "FAILED", true, "BUILD FAILURE");
        var failed = reports.verifyCriterion(
                sessionId,
                runId,
                acceptance.criteria().get(1).id(),
                failedCommand.id(),
                0);
        assertEquals(TaskReportStore.CriterionStatus.FAILED, failed.status());

        var rewritten = reports.saveAcceptanceCriteria(
                sessionId,
                runId,
                List.of("Automated test command exits successfully", "New criterion"));
        assertEquals(verified.id(), rewritten.criteria().get(0).id());
        assertEquals(TaskReportStore.CriterionStatus.PASSED,
                rewritten.criteria().get(0).status());
        assertThrows(IllegalArgumentException.class, () -> reports.verifyCriterion(
                sessionId,
                runId,
                rewritten.criteria().get(0).id(),
                UUID.randomUUID().toString(),
                0));
    }

    @Test
    void verifiesJsonOnlyFromCompleteSuccessfulOutputAndKeepsTheSchema() throws Exception {
        var reports = new TaskReportStore(temporary);
        String session = UUID.randomUUID().toString();
        String run = UUID.randomUUID().toString();
        String criterion = reports.saveAcceptanceCriteria(session, run, List.of("All checks passed"))
                .criteria().get(0).id();
        String schema = """
                {"type":"object","required":["passed"],"properties":{"passed":{"const":true}}}
                """.strip();
        var good = reports.recordCommand(session, run, "check", 1, 2, 0, "SUCCEEDED", false,
                "退出码 0\n{\"passed\":true}\r\n");
        var failed = reports.recordCommand(session, run, "check", 1, 2, 0, "SUCCEEDED", false,
                "退出码 0\n{\"passed\":false}");
        var nonJson = reports.recordCommand(session, run, "check", 1, 2, 0, "SUCCEEDED", false,
                "退出码 0\n{\"passed\":true}\nUnexpected log");
        var truncated = reports.recordCommand(session, run, "check", 1, 2, 0, "SUCCEEDED", false,
                good.output() + " ".repeat(12_000));
        var unsuccessful = reports.recordCommand(session, run, "check", 1, 2, 1, "FAILED", false,
                "退出码 1\n{\"passed\":true}");
        var differentRun = reports.recordCommand(session, UUID.randomUUID().toString(), "other check",
                1, 2, 0, "SUCCEEDED", false, good.output());
        assertEquals(TaskReportStore.CriterionStatus.FAILED,
                reports.verifyJsonCriterion(session, run, criterion, failed.id(), schema).status());
        assertEquals(TaskReportStore.CriterionStatus.FAILED,
                reports.verifyJsonCriterion(session, run, criterion, nonJson.id(), schema).status());
        assertTrue(truncated.outputTruncated());
        assertEquals(TaskReportStore.CriterionStatus.UNKNOWN,
                reports.verifyJsonCriterion(session, run, criterion, truncated.id(), schema).status());
        assertEquals(TaskReportStore.CriterionStatus.UNKNOWN,
                reports.verifyJsonCriterion(session, run, criterion, unsuccessful.id(), schema).status());
        assertThrows(IllegalArgumentException.class,
                () -> reports.verifyJsonCriterion(session, run, criterion, differentRun.id(), schema));
        var passed = reports.verifyJsonCriterion(session, run, criterion, good.id(), schema);
        assertEquals(TaskReportStore.CriterionStatus.PASSED, passed.status());
        assertEquals(schema, passed.jsonSchema());
        assertTrue(passed.verifier().startsWith("json-schema-v2:"));
        assertThrows(IllegalArgumentException.class,
                () -> reports.verifyJsonCriterion(session, run, criterion, good.id(), "{\"type\":\"bad\"}"));
        assertEquals(passed, new TaskReportStore(temporary).acceptance(session, run).criteria().get(0));
    }

    @Test
    void validatesArchivedJsonBeyondThePreviewAndHandlesUnavailableLogs() throws Exception {
        var reports = new TaskReportStore(temporary);
        String id = UUID.randomUUID().toString();
        String criterion = reports.saveAcceptanceCriteria("session", "run", List.of("检查结果"))
                .criteria().get(0).id();
        String schema = "{\"required\":[\"ok\"],\"properties\":{\"ok\":{\"const\":true}}}";
        reports.recordCommand(id, true, List.of(), "session", "run", "check", 1, 2, 0,
                "SUCCEEDED", true, "preview");
        Path log = reports.logPath("session", "run", id);
        String padding = "中".repeat(15_000);
        String raw = "{\"first\":\"" + padding + "\",\"ok\":true,\"last\":\"" + padding + "\"}";
        Files.writeString(log, raw);
        assertEquals(TaskReportStore.CriterionStatus.PASSED,
                reports.verifyJsonCriterion("session", "run", criterion, id, schema).status());
        Files.writeString(log, raw.replace("true", "false"));
        assertEquals(TaskReportStore.CriterionStatus.FAILED,
                reports.verifyJsonCriterion("session", "run", criterion, id, schema).status());
        Files.writeString(log, raw + " ".repeat(262_144));
        assertEquals(TaskReportStore.CriterionStatus.UNKNOWN,
                reports.verifyJsonCriterion("session", "run", criterion, id, schema).status());
        Files.delete(log);
        assertEquals(TaskReportStore.CriterionStatus.UNKNOWN,
                reports.verifyJsonCriterion("session", "run", criterion, id, schema).status());
    }

    private static void writeUnchecked(Path file, String text) {
        try {
            Files.writeString(file, text, StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
