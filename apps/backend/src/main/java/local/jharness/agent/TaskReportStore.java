package local.jharness.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.harness.agent.artifact.ArtifactDeliveryRequest;
import io.agentscope.harness.agent.artifact.ArtifactDeliveryResult;
import io.agentscope.harness.agent.verification.JsonResultSchemaVerifier;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Durable task evidence: the latest plan, command receipts and delivered artifacts.
 *
 * <p>The session journal remains the execution source of truth. This store keeps bounded,
 * user-reviewable projections beside project checkpoints so the desktop can present one task
 * report after a run has completed or been recovered.
 */
public final class TaskReportStore {
    public static final int MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
    private static final int MAX_COMMAND_OUTPUT = 12_000;
    private static final int MAX_PLAN_STEPS = 40;
    private static final int MAX_STEP_LENGTH = 240;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ConcurrentHashMap<Path, Object> LOCKS = new ConcurrentHashMap<>();

    public record PlanStep(String content, String status, String priority) {}

    public record Plan(
            String sessionId,
            String runId,
            long revision,
            long updatedAt,
            List<PlanStep> steps) {}

    public enum CriterionStatus {
        PENDING,
        PASSED,
        FAILED,
        UNKNOWN
    }

    public record AcceptanceCriterion(
            String id,
            String content,
            CriterionStatus status,
            String commandId,
            int expectedExitCode,
            String verifier,
            long verifiedAt,
            String reason,
            String jsonSchema) {}

    public record Acceptance(
            String sessionId,
            String runId,
            long revision,
            long updatedAt,
            List<AcceptanceCriterion> criteria) {}

    public enum CommandOutcome {
        SUCCEEDED,
        FAILED,
        UNKNOWN
    }

    public record CommandEvidence(
            String id,
            String sessionId,
            String runId,
            String command,
            long startedAt,
            long finishedAt,
            long durationMs,
            Integer exitCode,
            CommandOutcome outcome,
            boolean outputTruncated,
            String output, boolean logComplete, List<String> testFailures) {}

    public record Artifact(
            String id,
            String sessionId,
            String runId,
            String sourcePath,
            String fileName,
            String description,
            long size,
            String sha256,
            long createdAt,
            String filePath) {}

    public record TaskReport(
            String runId,
            long updatedAt,
            Plan plan,
            Acceptance acceptance,
            List<CommandEvidence> commands,
            List<Artifact> artifacts,
            List<ProjectCheckpointStore.Summary> checkpoints) {}

    private final Path directory;
    private final Path artifactRoot;
    private final Object lock;

    public TaskReportStore(Path workspace) throws IOException {
        Path root = Files.createDirectories(workspace.toAbsolutePath().normalize());
        directory = Files.createDirectories(root.resolve("task-reports"));
        artifactRoot = Files.createDirectories(root.resolve("artifacts"));
        lock = LOCKS.computeIfAbsent(root.toRealPath(), ignored -> new Object());
    }

    public Plan savePlan(String sessionId, String runId, List<PlanStep> steps) {
        String session = segment(sessionId, "会话");
        String run = segment(runId, "任务");
        List<PlanStep> normalized = normalizePlan(steps);
        synchronized (lock) {
            Plan prior = readPlan(session, run);
            long revision = prior == null ? 1 : prior.revision() + 1;
            var plan = new Plan(session, run, revision, System.currentTimeMillis(), normalized);
            write(planFile(session, run), plan);
            return plan;
        }
    }

    public Plan plan(String sessionId, String runId) {
        return readPlan(segment(sessionId, "会话"), segment(runId, "任务"));
    }

    public Acceptance saveAcceptanceCriteria(
            String sessionId, String runId, List<String> criteria) {
        String session = segment(sessionId, "会话");
        String run = segment(runId, "任务");
        List<String> normalized = normalizeCriteria(criteria);
        synchronized (lock) {
            Acceptance prior = readAcceptance(session, run);
            var previous = new LinkedHashMap<String, AcceptanceCriterion>();
            if (prior != null) {
                prior.criteria().forEach(item -> previous.put(item.content(), item));
            }
            var saved = new ArrayList<AcceptanceCriterion>();
            for (String content : normalized) {
                AcceptanceCriterion existing = previous.get(content);
                saved.add(existing != null ? existing : new AcceptanceCriterion(
                        UUID.randomUUID().toString(),
                        content,
                        CriterionStatus.PENDING,
                        "",
                        0,
                        "",
                        0,
                        "",
                        null));
            }
            var acceptance = new Acceptance(
                    session,
                    run,
                    prior == null ? 1 : prior.revision() + 1,
                    System.currentTimeMillis(),
                    List.copyOf(saved));
            write(acceptanceFile(session, run), acceptance);
            return acceptance;
        }
    }

    public Acceptance acceptance(String sessionId, String runId) {
        return readAcceptance(segment(sessionId, "会话"), segment(runId, "任务"));
    }

    public AcceptanceCriterion verifyCriterion(
            String sessionId,
            String runId,
            String criterionId,
            String commandId,
            int expectedExitCode) {
        if (expectedExitCode < 0 || expectedExitCode > 255)
            throw new IllegalArgumentException("期望退出码必须在 0 到 255 之间。");
        return verifyCriterion(sessionId, runId, criterionId, commandId, expectedExitCode, null);
    }

    public AcceptanceCriterion verifyJsonCriterion(
            String sessionId, String runId, String criterionId, String commandId, String jsonSchema) {
        if (jsonSchema == null || jsonSchema.isBlank())
            throw new IllegalArgumentException("请填写 JSON Schema。");
        return verifyCriterion(sessionId, runId, criterionId, commandId, 0, jsonSchema.strip());
    }

    private AcceptanceCriterion verifyCriterion(
            String sessionId, String runId, String criterionId, String commandId,
            int expectedExitCode, String jsonSchema) {
        String session = segment(sessionId, "会话");
        String run = segment(runId, "任务");
        segment(criterionId, "验收标准");
        segment(commandId, "命令证据");
        JsonResultSchemaVerifier jsonVerifier = null;
        if (jsonSchema != null) {
            try {
                jsonVerifier = JsonResultSchemaVerifier.fromJson(jsonSchema);
            } catch (RuntimeException error) {
                throw new IllegalArgumentException(
                        "JSON Schema 无效。请填写 65,536 字符以内的 Draft 2020-12 对象，省略引用和版本声明。",
                        error);
            }
        }
        synchronized (lock) {
            Acceptance current = readAcceptance(session, run);
            if (current == null) throw new IllegalArgumentException("此运行还没有验收标准。");
            AcceptanceCriterion criterion = current.criteria().stream()
                    .filter(item -> item.id().equals(criterionId))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("找不到验收标准。"));
            CommandEvidence command = commands(session, run).stream()
                    .filter(item -> commandId.equals(item.id())
                            && session.equals(item.sessionId()) && run.equals(item.runId()))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("找不到同一运行中的命令证据。"));
            AcceptanceCriterion verified = jsonVerifier == null
                    ? verifyExitCode(criterion, command, expectedExitCode)
                    : verifyJson(criterion, command, jsonVerifier, jsonSchema);
            var updated = new ArrayList<>(current.criteria());
            for (int i = 0; i < updated.size(); i++) {
                if (updated.get(i).id().equals(criterionId)) {
                    updated.set(i, verified);
                    break;
                }
            }
            write(acceptanceFile(session, run), new Acceptance(
                    session,
                    run,
                    current.revision() + 1,
                    System.currentTimeMillis(),
                    List.copyOf(updated)));
            return verified;
        }
    }

    public CommandEvidence recordCommand(
            String sessionId,
            String runId,
            String command,
            long startedAt,
            long finishedAt,
            Integer exitCode,
            String outcome,
            boolean outputTruncated,
            String output) {
        return recordCommand(UUID.randomUUID().toString(), false, List.of(), sessionId, runId, command, startedAt,
                finishedAt, exitCode, outcome, outputTruncated, output);
    }

    Path logPath(String session, String run, String id) {
        return commandDirectory(segment(session, "会话"), segment(run, "任务")).resolve(segment(id, "命令") + ".txt");
    }

    public String commandLog(String session, String run, String id) {
        Path path = logPath(session, run, id);
        if (commands(session, run).stream().noneMatch(command -> command.id().equals(id) && command.logComplete())
                || !Files.isRegularFile(path)) throw new IllegalArgumentException("找不到完整命令日志。");
        return path.toString();
    }

    CommandEvidence recordCommand(String id, boolean logComplete, List<String> failures, String sessionId, String runId, String command,
            long startedAt, long finishedAt, Integer exitCode, String outcome, boolean outputTruncated, String output) {
        String session = segment(sessionId, "会话");
        String run = segment(runId, "任务");
        if (command == null || command.isBlank() || command.length() > 8_000)
            throw new IllegalArgumentException("命令证据无效。");
        CommandOutcome parsed = parseOutcome(outcome);
        var evidence = new CommandEvidence(
                id,
                session,
                run,
                command,
                startedAt,
                finishedAt,
                Math.max(0, finishedAt - startedAt),
                exitCode,
                parsed,
                outputTruncated || (output != null && output.length() > MAX_COMMAND_OUTPUT),
                output != null && output.length() > MAX_COMMAND_OUTPUT
                        ? output.substring(0, 5900) + "\n[输出已截断，保留首尾]\n" + output.substring(output.length() - 5900)
                        : bounded(output, MAX_COMMAND_OUTPUT), logComplete, List.copyOf(failures));
        synchronized (lock) {
            write(commandDirectory(session, run).resolve(evidence.id() + ".json"), evidence);
        }
        return evidence;
    }

    public ArtifactDeliveryResult deliver(
            String sessionId, String runId, ArtifactDeliveryRequest request) {
        if (request == null) return ArtifactDeliveryResult.fail("artifact request is missing");
        try {
            Artifact artifact = saveArtifact(sessionId, runId, request);
            return ArtifactDeliveryResult.success(artifact.fileName() + " (" + artifact.size() + " bytes)");
        } catch (ArtifactConflictException error) {
            return ArtifactDeliveryResult.conflict(error.getMessage());
        } catch (IllegalArgumentException error) {
            return ArtifactDeliveryResult.fail(error.getMessage());
        } catch (RuntimeException error) {
            return ArtifactDeliveryResult.fail("artifact could not be stored");
        }
    }

    public Artifact saveArtifact(
            String sessionId, String runId, ArtifactDeliveryRequest request) {
        String session = segment(sessionId, "会话");
        String run = segment(runId, "任务");
        String fileName = plainFileName(request.fileName());
        byte[] content = request.content();
        if (content == null) throw new IllegalArgumentException("交付物内容为空。");
        if (content.length > MAX_ARTIFACT_BYTES)
            throw new IllegalArgumentException("交付物不能超过 32 MiB。");
        String description = bounded(request.description(), 1_000);
        String source = safeSourcePath(request.filePath());
        synchronized (lock) {
            Artifact existing = artifacts(session, run).stream()
                    .filter(item -> item.fileName().equals(fileName))
                    .findFirst()
                    .orElse(null);
            if (existing != null && !request.force())
                throw new ArtifactConflictException("同名交付物已存在。");
            String id = existing == null ? UUID.randomUUID().toString() : existing.id();
            Path artifactDirectory = artifactDirectory(session, run, id);
            Path file = artifactDirectory.resolve(fileName);
            writeBytes(file, content);
            var artifact = new Artifact(
                    id,
                    session,
                    run,
                    source,
                    fileName,
                    description,
                    content.length,
                    hash(content),
                    System.currentTimeMillis(),
                    file.toAbsolutePath().toString());
            write(artifactFile(session, run, id), artifact);
            return artifact;
        }
    }

    public Artifact artifact(String sessionId, String id) {
        String session = segment(sessionId, "会话");
        segment(id, "交付物");
        Path sessionDirectory = directory.resolve(session);
        if (!Files.isDirectory(sessionDirectory)) throw new IllegalArgumentException("找不到交付物。");
        try (var runs = Files.list(sessionDirectory)) {
            for (Path runDirectory : runs.filter(Files::isDirectory).toList()) {
                Path file = runDirectory.resolve("artifacts").resolve(id + ".json");
                if (Files.isRegularFile(file)) {
                    Artifact artifact = JSON.readValue(file.toFile(), Artifact.class);
                    if (!session.equals(artifact.sessionId()))
                        throw new IllegalArgumentException("交付物不属于当前会话。");
                    return artifact;
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法读取交付物。", error);
        }
        throw new IllegalArgumentException("找不到交付物。");
    }

    public List<TaskReport> reports(
            String sessionId, List<ProjectCheckpointStore.Summary> checkpoints) {
        String session = segment(sessionId, "会话");
        Set<String> runs = new LinkedHashSet<>();
        Path sessionDirectory = directory.resolve(session);
        if (Files.isDirectory(sessionDirectory)) {
            try (var entries = Files.list(sessionDirectory)) {
                entries.filter(Files::isDirectory)
                        .map(path -> path.getFileName().toString())
                        .filter(value -> validSegment(value))
                        .forEach(runs::add);
            } catch (IOException error) {
                throw new IllegalStateException("无法读取任务报告。", error);
            }
        }
        for (ProjectCheckpointStore.Summary checkpoint : checkpoints) {
            if (session.equals(checkpoint.sessionId()) && validSegment(checkpoint.runId()))
                runs.add(checkpoint.runId());
        }
        var reports = new ArrayList<TaskReport>();
        for (String run : runs) {
            Plan plan = readPlan(session, run);
            Acceptance acceptance = readAcceptance(session, run);
            List<CommandEvidence> commands = commands(session, run);
            List<Artifact> artifacts = artifacts(session, run);
            List<ProjectCheckpointStore.Summary> owned = checkpoints.stream()
                    .filter(item -> session.equals(item.sessionId()) && run.equals(item.runId()))
                    .toList();
            long updatedAt = Math.max(
                    plan == null ? 0 : plan.updatedAt(),
                    Math.max(
                            acceptance == null ? 0 : acceptance.updatedAt(),
                            Math.max(
                                    commands.stream().mapToLong(CommandEvidence::finishedAt).max().orElse(0),
                                    Math.max(
                                            artifacts.stream().mapToLong(Artifact::createdAt).max().orElse(0),
                                            owned.stream()
                                                    .mapToLong(ProjectCheckpointStore.Summary::updatedAt)
                                                    .max().orElse(0)))));
            if (updatedAt == 0) continue;
            reports.add(new TaskReport(
                    run, updatedAt, plan, acceptance, commands, artifacts, owned));
        }
        reports.sort(Comparator.comparingLong(TaskReport::updatedAt).reversed());
        return List.copyOf(reports.stream().limit(100).toList());
    }

    private Plan readPlan(String session, String run) {
        Path file = planFile(session, run);
        if (!Files.isRegularFile(file)) return null;
        try {
            return JSON.readValue(file.toFile(), Plan.class);
        } catch (IOException error) {
            return null;
        }
    }

    private Acceptance readAcceptance(String session, String run) {
        Path file = acceptanceFile(session, run);
        if (!Files.isRegularFile(file)) return null;
        try {
            return JSON.readValue(file.toFile(), Acceptance.class);
        } catch (IOException error) {
            return null;
        }
    }

    private List<CommandEvidence> commands(String session, String run) {
        Path directory = commandDirectory(session, run);
        if (!Files.isDirectory(directory)) return List.of();
        var result = new ArrayList<CommandEvidence>();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .limit(2_000).toList()) {
                try {
                    result.add(JSON.readValue(file.toFile(), CommandEvidence.class));
                } catch (IOException ignored) {
                    // One damaged receipt must not hide the rest of the report.
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法读取命令证据。", error);
        }
        result.sort(Comparator.comparingLong(CommandEvidence::startedAt));
        return List.copyOf(result.stream().limit(200).toList());
    }

    private List<Artifact> artifacts(String session, String run) {
        Path directory = artifactMetadataDirectory(session, run);
        if (!Files.isDirectory(directory)) return List.of();
        var result = new ArrayList<Artifact>();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .limit(500).toList()) {
                try {
                    result.add(JSON.readValue(file.toFile(), Artifact.class));
                } catch (IOException ignored) {
                    // Damaged metadata remains isolated from other artifacts.
                }
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法读取交付物。", error);
        }
        result.sort(Comparator.comparingLong(Artifact::createdAt));
        return List.copyOf(result);
    }

    private static List<PlanStep> normalizePlan(List<PlanStep> steps) {
        if (steps == null) return List.of();
        if (steps.size() > MAX_PLAN_STEPS)
            throw new IllegalArgumentException("计划最多包含 40 个步骤。");
        var result = new ArrayList<PlanStep>();
        int active = 0;
        for (PlanStep step : steps) {
            if (step == null) throw new IllegalArgumentException("计划步骤不能为空。");
            String content = bounded(step.content(), MAX_STEP_LENGTH).strip();
            if (content.isEmpty()) throw new IllegalArgumentException("计划步骤不能为空。");
            String status = lower(step.status(), "pending");
            if (!Set.of("pending", "in_progress", "completed").contains(status))
                throw new IllegalArgumentException("计划步骤状态无效。");
            if (status.equals("in_progress")) active++;
            String priority = lower(step.priority(), "");
            if (!priority.isEmpty() && !Set.of("high", "medium", "low").contains(priority))
                priority = "";
            result.add(new PlanStep(content, status, priority));
        }
        if (active > 1) throw new IllegalArgumentException("计划中最多只能有一个进行中步骤。");
        return List.copyOf(result);
    }

    private static List<String> normalizeCriteria(List<String> criteria) {
        if (criteria == null) return List.of();
        if (criteria.size() > 20)
            throw new IllegalArgumentException("每次最多保存 20 项验收标准。");
        var result = new ArrayList<String>();
        for (String criterion : criteria) {
            String content = bounded(criterion, MAX_STEP_LENGTH).strip();
            if (content.isEmpty()) throw new IllegalArgumentException("验收标准不能为空。");
            if (!result.contains(content)) result.add(content);
        }
        return List.copyOf(result);
    }

    private static AcceptanceCriterion verifyExitCode(
            AcceptanceCriterion criterion,
            CommandEvidence command,
            int expectedExitCode) {
        long now = System.currentTimeMillis();
        String verifier = "shell-exit-v1:" + expectedExitCode;
        if (command.outputTruncated()) {
            return result(criterion, CriterionStatus.UNKNOWN, command, expectedExitCode,
                    verifier, now, "命令输出被截断，无法形成完整退出码证据。");
        }
        if (command.exitCode() == null || command.outcome() == CommandOutcome.UNKNOWN) {
            return result(criterion, CriterionStatus.UNKNOWN, command, expectedExitCode,
                    verifier, now, "命令退出结果未知。");
        }
        if ((command.exitCode() == 0) != (command.outcome() == CommandOutcome.SUCCEEDED)) {
            return result(criterion, CriterionStatus.UNKNOWN, command, expectedExitCode,
                    verifier, now, "退出码与命令结果不一致。");
        }
        if (command.exitCode() != expectedExitCode) {
            return result(criterion, CriterionStatus.FAILED, command, expectedExitCode,
                    verifier, now, "命令退出码不符合期望。");
        }
        return result(criterion, CriterionStatus.PASSED, command, expectedExitCode,
                verifier, now, "命令返回期望退出码；此结论不覆盖其他语义验收。");
    }

    private static AcceptanceCriterion verifyJson(
            AcceptanceCriterion criterion, CommandEvidence command,
            JsonResultSchemaVerifier verifier, String jsonSchema) {
        CriterionStatus status = CriterionStatus.UNKNOWN;
        String reason = "需要一次退出码为 0 且输出完整的成功命令。";
        String output = command.output();
        String prefix = "退出码 0\n";
        // Older receipts lost the truncation flag when the report itself shortened the output.
        if (!command.outputTruncated() && Integer.valueOf(0).equals(command.exitCode())
                && command.outcome() == CommandOutcome.SUCCEEDED && output != null
                && output.length() < MAX_COMMAND_OUTPUT && output.startsWith(prefix)) {
            var verdict = verifier.verifySuccessfulOutput(output.substring(prefix.length()));
            switch (verdict.outcome()) {
                case PASSED -> {
                    status = CriterionStatus.PASSED;
                    reason = "命令输出符合 JSON Schema。";
                }
                case FAILED -> {
                    status = CriterionStatus.FAILED;
                    reason = "命令输出无效或不符合 JSON Schema。";
                }
                default -> reason = "命令未提供可核验的 JSON 输出。";
            }
        }
        return new AcceptanceCriterion(criterion.id(), criterion.content(), status, command.id(),
                0, verifier.id(), System.currentTimeMillis(), reason, jsonSchema);
    }

    private static AcceptanceCriterion result(
            AcceptanceCriterion criterion,
            CriterionStatus status,
            CommandEvidence command,
            int expectedExitCode,
            String verifier,
            long verifiedAt,
            String reason) {
        return new AcceptanceCriterion(
                criterion.id(),
                criterion.content(),
                status,
                command.id(),
                expectedExitCode,
                verifier,
                verifiedAt,
                reason,
                null);
    }

    private static CommandOutcome parseOutcome(String value) {
        if (value == null) return CommandOutcome.UNKNOWN;
        return switch (value.toUpperCase(Locale.ROOT)) {
            case "SUCCEEDED", "SUCCESS" -> CommandOutcome.SUCCEEDED;
            case "FAILED", "ERROR" -> CommandOutcome.FAILED;
            default -> CommandOutcome.UNKNOWN;
        };
    }

    private Path reportDirectory(String session) {
        return directory.resolve(session);
    }

    private Path runDirectory(String session, String run) {
        return reportDirectory(session).resolve(run);
    }

    private Path planFile(String session, String run) {
        return runDirectory(session, run).resolve("plan.json");
    }

    private Path acceptanceFile(String session, String run) {
        return runDirectory(session, run).resolve("acceptance.json");
    }

    private Path commandDirectory(String session, String run) {
        return runDirectory(session, run).resolve("commands");
    }

    private Path artifactMetadataDirectory(String session, String run) {
        return runDirectory(session, run).resolve("artifacts");
    }

    private Path artifactFile(String session, String run, String id) {
        return artifactMetadataDirectory(session, run).resolve(id + ".json");
    }

    private Path artifactDirectory(String session, String run, String id) {
        return artifactRoot.resolve(session).resolve(run).resolve(id);
    }

    private void write(Path file, Object value) {
        try {
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), ".task-report-", ".tmp");
            try {
                JSON.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), value);
                move(temporary, file);
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法保存任务报告。", error);
        }
    }

    private static void writeBytes(Path file, byte[] content) {
        try {
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), ".artifact-", ".tmp");
            try {
                Files.write(temporary, content);
                move(temporary, file);
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法保存交付物。", error);
        }
    }

    private static void move(Path source, Path target) throws IOException {
        try {
            Files.move(
                    source,
                    target,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String segment(String value, String label) {
        if (!validSegment(value)) throw new IllegalArgumentException(label + "标识无效。");
        return value;
    }

    private static boolean validSegment(String value) {
        return value != null && value.matches("[A-Za-z0-9._-]{1,120}")
                && !value.equals(".") && !value.equals("..");
    }

    private static String plainFileName(String value) {
        if (value == null || value.isBlank() || value.length() > 180
                || value.contains("/") || value.contains("\\") || value.indexOf(0) >= 0
                || value.equals(".") || value.equals(".."))
            throw new IllegalArgumentException("交付物文件名无效。");
        return value;
    }

    private static String safeSourcePath(String value) {
        if (value == null) return "";
        String source = value.replace('\\', '/').strip();
        while (source.startsWith("/")) source = source.substring(1);
        return bounded(source, 500);
    }

    private static String bounded(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    private static String lower(String value, String fallback) {
        return value == null || value.isBlank()
                ? fallback
                : value.strip().toLowerCase(Locale.ROOT);
    }

    private static String hash(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (Exception error) {
            throw new IllegalStateException("无法计算交付物哈希。", error);
        }
    }

    private static final class ArtifactConflictException extends IllegalArgumentException {
        ArtifactConflictException(String message) {
            super(message);
        }
    }
}
