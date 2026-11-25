package local.jharness.agent;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.ToolResultBlock;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/** File snapshots captured around approved project writes. */
public final class ProjectCheckpointStore {
    public enum Status {
        RUNNING,
        SUCCESS,
        ERROR,
        RESTORED
    }

    public record Snapshot(boolean exists, String text, String hash) {}

    public record Checkpoint(
            String id,
            String sessionId,
            String runId,
            String operation,
            String path,
            long createdAt,
            long updatedAt,
            Status status,
            Snapshot before,
            Snapshot after) {}

    public record Summary(
            String id,
            String sessionId,
            String runId,
            String operation,
            String path,
            long createdAt,
            long updatedAt,
            Status status,
            boolean beforeExists,
            boolean afterExists) {}

    public record FilePreview(
            String path,
            String operation,
            int checkpointCount,
            boolean beforeExists,
            boolean afterExists,
            boolean currentExists,
            boolean matchesAfter) {}

    public record RestorePreview(
            String sessionId,
            String runId,
            int checkpointCount,
            List<FilePreview> files,
            List<String> conflicts) {
        @JsonProperty("canRestore")
        public boolean canRestore() {
            return !files.isEmpty() && conflicts.isEmpty();
        }
    }

    public enum ChangeSetStatus {
        RUNNING,
        RESTORED,
        ERROR
    }

    public record ChangeSet(
            String id,
            String sessionId,
            String runId,
            long startedAt,
            long finishedAt,
            ChangeSetStatus status,
            List<String> paths,
            List<String> conflicts,
            String error) {}

    private static final ObjectMapper JSON = new ObjectMapper().disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    @JsonIgnoreProperties({"text"})
    private interface SnapshotHeader {}
    private static final ObjectMapper HEADERS = JSON.copy().addMixIn(Snapshot.class, SnapshotHeader.class);
    private static final ConcurrentHashMap<Path, Object> LOCKS = new ConcurrentHashMap<>();
    private final Path root;
    private final Path directory;
    private final Path changeSetDirectory;
    private final Object lock;

    private record PlannedFile(String path, List<Summary> checkpoints) {
        Summary first() { return checkpoints.get(0); }
        Summary latest() { return checkpoints.get(checkpoints.size() - 1); }
    }

    public ProjectCheckpointStore(Path workspace, Path project) throws IOException {
        root = project.toRealPath();
        directory = Files.createDirectories(workspace.resolve("checkpoints"));
        changeSetDirectory = Files.createDirectories(workspace.resolve("checkpoint-change-sets"));
        lock = LOCKS.computeIfAbsent(directory.toAbsolutePath().normalize(), ignored -> new Object());
    }

    public ToolResultBlock run(
            String sessionId,
            String runId,
            String operation,
            String relativePath,
            Supplier<ToolResultBlock> action) {
        String id = UUID.randomUUID().toString();
        Path file = safeFile(relativePath);
        Checkpoint record;
        synchronized (lock) {
            long now = nextTimestamp();
            record = new Checkpoint(
                    id,
                    sessionId,
                    runId,
                    operation,
                    relativePath,
                    now,
                    now,
                    Status.RUNNING,
                    snapshot(file),
                    new Snapshot(false, "", ""));
            save(record);
        }
        ToolResultBlock result;
        Snapshot after;
        try {
            result = action.get();
            after = snapshot(file);
            if ("SUCCESS".equals(result.getState().name()) && !after.exists())
                throw new IllegalStateException("写入完成后找不到文件，检查点无法用于恢复。");
        } catch (RuntimeException error) {
            save(new Checkpoint(
                    record.id(),
                    record.sessionId(),
                    record.runId(),
                    record.operation(),
                    record.path(),
                    record.createdAt(),
                    System.currentTimeMillis(),
                    Status.ERROR,
                    record.before(),
                    new Snapshot(false, "", "")));
            throw error;
        }
        save(new Checkpoint(
                record.id(),
                record.sessionId(),
                record.runId(),
                record.operation(),
                record.path(),
                record.createdAt(),
                System.currentTimeMillis(),
                result.getState().name().equals("SUCCESS") ? Status.SUCCESS : Status.ERROR,
                record.before(),
                after));
        return result;
    }

    public List<Summary> list(String sessionId) {
        return summaries(sessionId, 200);
    }

    List<Summary> summaries(String sessionId, int limit) {
        try (var files = Files.list(directory)) {
            var result = new ArrayList<Summary>();
            files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .forEach(path -> {
                        try {
                            var checkpoint = HEADERS.readValue(path.toFile(), Checkpoint.class);
                            if (sessionId == null || sessionId.isBlank()
                                    || sessionId.equals(checkpoint.sessionId()))
                                result.add(new Summary(
                                        checkpoint.id(),
                                        checkpoint.sessionId(),
                                        checkpoint.runId(),
                                        checkpoint.operation(),
                                        checkpoint.path(),
                                        checkpoint.createdAt(),
                                        checkpoint.updatedAt(),
                                        checkpoint.status(),
                                        checkpoint.before().exists(),
                                        checkpoint.after().exists()));
                        } catch (IOException ignored) {
                            // A damaged checkpoint remains isolated from other history.
                        }
                    });
            result.sort(Comparator.comparingLong(Summary::createdAt).reversed());
            return List.copyOf(result.stream().limit(limit).toList());
        } catch (IOException error) {
            throw new IllegalStateException("无法读取项目检查点。", error);
        }
    }

    public RestorePreview previewRun(String sessionId, String runId) {
        validateIdentity(sessionId);
        validateIdentity(runId);
        synchronized (lock) {
            return previewLocked(sessionId, runId);
        }
    }

    /**
     * Restores the earliest before snapshot of every file changed by one run.
     *
     * <p>Every target is preflighted before the first mutation. The successful state is also kept
     * in a persisted change-set record so a partial filesystem failure can be rolled back safely.
     */
    public ChangeSet restoreRun(String sessionId, String runId) {
        validateIdentity(sessionId);
        validateIdentity(runId);
        synchronized (lock) {
            RestorePreview preview = previewLocked(sessionId, runId);
            if (preview.files().isEmpty())
                throw new IllegalArgumentException("此任务没有可恢复的文件改动。");
            if (!preview.conflicts().isEmpty())
                throw new IllegalStateException(
                        "部分文件在任务结束后又被修改，整组恢复已取消。请先逐项核对冲突文件。");
            List<PlannedFile> planned = planned(sessionId, runId);
            String id = UUID.randomUUID().toString();
            long startedAt = System.currentTimeMillis();
            saveChangeSet(new ChangeSet(
                    id,
                    sessionId,
                    runId,
                    startedAt,
                    startedAt,
                    ChangeSetStatus.RUNNING,
                    planned.stream().map(PlannedFile::path).toList(),
                    List.of(),
                    ""));
            var applied = new ArrayList<PlannedFile>();
            try {
                for (PlannedFile file : planned) {
                    Path target = safeRestoreFile(file.path());
                    if (!matches(target, get(file.latest().id()).after()))
                        throw new IllegalStateException("文件在恢复过程中发生变化。");
                    applySnapshot(target, get(file.first().id()).before());
                    applied.add(file);
                }
            } catch (RuntimeException error) {
                String rollbackError = rollback(applied);
                saveChangeSet(new ChangeSet(
                        id,
                        sessionId,
                        runId,
                        startedAt,
                        System.currentTimeMillis(),
                        ChangeSetStatus.ERROR,
                        planned.stream().map(PlannedFile::path).toList(),
                        preview.conflicts(),
                        rollbackError == null ? safeMessage(error) : rollbackError));
                throw new IllegalStateException(
                        rollbackError == null
                                ? "整组恢复失败，已尝试撤销已写入的文件。"
                                : "整组恢复失败，且未能完整撤销已写入的文件。请检查工作区。",
                        error);
            }
            for (PlannedFile file : planned) {
                for (Summary summary : file.checkpoints()) {
                    Checkpoint checkpoint = get(summary.id());
                    save(new Checkpoint(
                            checkpoint.id(),
                            checkpoint.sessionId(),
                            checkpoint.runId(),
                            checkpoint.operation(),
                            checkpoint.path(),
                            checkpoint.createdAt(),
                            System.currentTimeMillis(),
                            Status.RESTORED,
                            checkpoint.before(),
                            checkpoint.after()));
                }
            }
            var restored = new ChangeSet(
                    id,
                    sessionId,
                    runId,
                    startedAt,
                    System.currentTimeMillis(),
                    ChangeSetStatus.RESTORED,
                    planned.stream().map(PlannedFile::path).toList(),
                    List.of(),
                    "");
            saveChangeSet(restored);
            return restored;
        }
    }

    public List<ChangeSet> changeSets(String sessionId, String runId) {
        validateIdentity(sessionId);
        validateIdentity(runId);
        try (var files = Files.list(changeSetDirectory)) {
            var result = new ArrayList<ChangeSet>();
            for (Path path : files.filter(item -> item.getFileName().toString().endsWith(".json"))
                    .limit(1000).toList()) {
                try {
                    ChangeSet changeSet = JSON.readValue(path.toFile(), ChangeSet.class);
                    if (sessionId.equals(changeSet.sessionId()) && runId.equals(changeSet.runId()))
                        result.add(changeSet);
                } catch (IOException ignored) {
                    // Isolate damaged audit records from the remaining history.
                }
            }
            result.sort(Comparator.comparingLong(ChangeSet::startedAt).reversed());
            return List.copyOf(result);
        } catch (IOException error) {
            throw new IllegalStateException("无法读取整组恢复记录。", error);
        }
    }

    public Checkpoint get(String id) {
        validateId(id);
        try {
            return JSON.readValue(file(id).toFile(), Checkpoint.class);
        } catch (IOException error) {
            throw new IllegalArgumentException("找不到检查点。", error);
        }
    }

    public Checkpoint restore(String id) {
        var checkpoint = get(id);
        if (!checkpoint.status().equals(Status.SUCCESS))
            throw new IllegalArgumentException("只有已成功完成的检查点可以恢复。");
        Path file = safeRestoreFile(checkpoint.path());
        if (!matches(file, checkpoint.after()))
            throw new IllegalStateException("文件在检查点后已被修改或删除。为避免覆盖后续编辑，本次恢复已取消。");
        applySnapshot(file, checkpoint.before());
        var restored = new Checkpoint(
                checkpoint.id(),
                checkpoint.sessionId(),
                checkpoint.runId(),
                checkpoint.operation(),
                checkpoint.path(),
                checkpoint.createdAt(),
                System.currentTimeMillis(),
                Status.RESTORED,
                checkpoint.before(),
                checkpoint.after());
        save(restored);
        return restored;
    }

    /** Only file fingerprints are loaded here. Snapshot bodies stay on disk. */
    record FileChange(String run, String path, long at, String expected) {}

    record Coverage(List<FileChange> changes, Map<String, String> disk) {
        Map<String, String> baseline(String run) {
            var result = new LinkedHashMap<String, String>();
            for (var change : changes) {
                String fingerprint = disk.get(change.path());
                if (run.equals(change.run()) && fingerprint != null) result.put(change.path(), fingerprint);
            }
            return result;
        }

        List<String> changed(String run, long startedAt, Map<String, String> baseline) {
            var paths = new java.util.LinkedHashSet<String>();
            var expected = new LinkedHashMap<String, String>();
            var tracked = new java.util.LinkedHashSet<String>();
            for (var change : changes) {
                if (change.at() >= startedAt) paths.add(change.path());
                if (run.equals(change.run())) tracked.add(change.path());
                expected.put(change.path(), change.expected());
            }
            for (String path : tracked) {
                String reference = baseline.getOrDefault(path, expected.get(path));
                if (disk.containsKey(path) && (reference == null || !reference.equals(disk.get(path)))) paths.add(path);
            }
            return List.copyOf(paths);
        }
    }

    Coverage coverage(String session, String onlyRun) {
        var changes = new ArrayList<FileChange>();
        var restored = new ArrayList<Checkpoint>();
        synchronized (lock) {
            try (var files = Files.newDirectoryStream(directory, "*.json")) {
                for (Path file : files) {
                    Checkpoint cp;
                    try { cp = HEADERS.readValue(file.toFile(), Checkpoint.class); }
                    catch (IOException ignored) { continue; }
                    if (!session.equals(cp.sessionId()) || (onlyRun != null && !onlyRun.equals(cp.runId()))
                            || !("edit_file".equals(cp.operation()) || "create_file".equals(cp.operation()))
                            || (cp.status() != Status.SUCCESS && cp.status() != Status.RESTORED)) continue;
                    changes.add(new FileChange(cp.runId(), cp.path(), cp.status() == Status.RESTORED
                            ? cp.createdAt() : Math.max(cp.createdAt(), cp.updatedAt()), fingerprint(cp.after())));
                    if (cp.status() == Status.RESTORED) restored.add(cp);
                }
            } catch (IOException e) { throw new IllegalStateException("无法读取文件检查点。", e); }
            // A group undo applies the earliest before-image of each path once, even if
            // several edits of that path are subsequently marked RESTORED in the audit log.
            restored.sort(Comparator.comparingLong(Checkpoint::createdAt).reversed());
            var groups = new LinkedHashMap<String, List<ChangeSet>>();
            for (var cp : restored) {
                long at = cp.updatedAt();
                for (var group : groups.computeIfAbsent(cp.runId(), run -> changeSets(session, run))) {
                    if (group.status() == ChangeSetStatus.RESTORED && group.paths().contains(cp.path())
                            && group.startedAt() <= at && at <= group.finishedAt()) {
                        at = group.finishedAt();
                        break;
                    }
                }
                changes.add(new FileChange(cp.runId(), cp.path(), at, fingerprint(cp.before())));
            }
        }
        changes.sort(Comparator.comparingLong(FileChange::at));
        var disk = new LinkedHashMap<String, String>();
        for (var change : changes) {
            if (disk.containsKey(change.path())) continue;
            try { disk.put(change.path(), fingerprint(snapshot(safeRestoreFile(change.path())))); }
            catch (RuntimeException unreadable) { disk.put(change.path(), null); }
        }
        return new Coverage(changes, disk);
    }

    private static String fingerprint(Snapshot value) {
        return value == null ? null : value.exists() ? value.hash() : "missing";
    }

    private Snapshot snapshot(Path file) {
        if (Files.notExists(file, LinkOption.NOFOLLOW_LINKS)) return new Snapshot(false, "", "");
        try {
            String text = ProjectTools.readText(file);
            return new Snapshot(true, text, hash(text));
        } catch (IOException error) {
            throw new IllegalStateException("无法保存文件快照。请检查访问权限、UTF-8 编码及 8 MiB 大小限制。", error);
        }
    }

    private long nextTimestamp() {
        long latest = 0;
        try (var files = Files.list(directory)) {
            for (Path path : files.filter(item -> item.getFileName().toString().endsWith(".json"))
                    .limit(2000).toList()) {
                try {
                    latest = Math.max(latest, HEADERS.readValue(path.toFile(), Checkpoint.class).createdAt());
                } catch (IOException ignored) {
                    // A damaged checkpoint must not block new evidence.
                }
            }
        } catch (IOException ignored) {
            // The directory exists; fall back to wall-clock ordering.
        }
        return Math.max(System.currentTimeMillis(), latest + 1);
    }

    private RestorePreview previewLocked(String sessionId, String runId) {
        List<PlannedFile> planned = planned(sessionId, runId);
        var files = new ArrayList<FilePreview>();
        var conflicts = new ArrayList<String>();
        int checkpointCount = 0;
        for (PlannedFile file : planned) {
            checkpointCount += file.checkpoints().size();
            Path target = safeRestoreFile(file.path());
            boolean currentExists = Files.exists(target, LinkOption.NOFOLLOW_LINKS);
            boolean matches = matches(target, get(file.latest().id()).after());
            files.add(new FilePreview(
                    file.path(),
                    file.latest().operation(),
                    file.checkpoints().size(),
                    file.first().beforeExists(),
                    file.latest().afterExists(),
                    currentExists,
                    matches));
            if (!matches) conflicts.add(file.path());
        }
        files.sort(Comparator.comparing(FilePreview::path));
        conflicts.sort(String::compareTo);
        return new RestorePreview(
                sessionId, runId, checkpointCount, List.copyOf(files), List.copyOf(conflicts));
    }

    private List<PlannedFile> planned(String sessionId, String runId) {
        var grouped = new LinkedHashMap<String, List<Summary>>();
        for (Summary summary : list(sessionId)) {
            if (!runId.equals(summary.runId()) || !Status.SUCCESS.equals(summary.status())) continue;
            grouped.computeIfAbsent(summary.path(), ignored -> new ArrayList<>()).add(summary);
        }
        var result = new ArrayList<PlannedFile>();
        for (var entry : grouped.entrySet()) {
            var checkpoints = new ArrayList<>(entry.getValue());
            checkpoints.sort(Comparator.comparingLong(Summary::createdAt).thenComparing(Summary::id));
            result.add(new PlannedFile(entry.getKey(), List.copyOf(checkpoints)));
        }
        result.sort(Comparator.comparing(PlannedFile::path));
        return List.copyOf(result);
    }

    private boolean matches(Path file, Snapshot expected) {
        if (!expected.exists()) return Files.notExists(file, LinkOption.NOFOLLOW_LINKS);
        try {
            String text = ProjectTools.readText(file);
            return expected.text().equals(text) && expected.hash().equals(hash(text));
        } catch (IOException error) {
            return false;
        }
    }

    private void applySnapshot(Path file, Snapshot snapshot) {
        try {
            if (!snapshot.exists()) {
                Files.deleteIfExists(file);
                return;
            }
            Files.createDirectories(file.getParent());
            Path temporary = Files.createTempFile(file.getParent(), ".jharness-restore-", ".tmp");
            try {
                Files.writeString(temporary, snapshot.text(), StandardCharsets.UTF_8);
                try {
                    Files.move(
                            temporary,
                            file,
                            StandardCopyOption.ATOMIC_MOVE,
                            StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException error) {
                    Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法恢复检查点文件。", error);
        }
    }

    private String rollback(List<PlannedFile> applied) {
        var failures = new ArrayList<String>();
        for (int i = applied.size() - 1; i >= 0; i--) {
            PlannedFile file = applied.get(i);
            try {
                Path target = safeRestoreFile(file.path());
                if (!matches(target, get(file.first().id()).before()))
                    throw new IllegalStateException("文件在恢复过程中发生变化。");
                applySnapshot(target, get(file.latest().id()).after());
            } catch (RuntimeException error) {
                failures.add(file.path());
            }
        }
        return failures.isEmpty()
                ? null
                : "以下文件未能撤销：" + String.join("、", failures);
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? "未知文件系统错误" : message;
    }

    private Path safeRestoreFile(String relativePath) {
        Path relative = Path.of(relativePath);
        if (relative.isAbsolute() || relative.getRoot() != null)
            throw new IllegalArgumentException("检查点路径无效。");
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root) || file.equals(root))
            throw new IllegalArgumentException("检查点路径超出项目。");
        try {
            Path ancestor = file.getParent();
            while (ancestor != null && !Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS))
                ancestor = ancestor.getParent();
            if (ancestor == null || !Files.exists(ancestor))
                throw new IllegalArgumentException("检查点路径超出项目。");
            Path realAncestor = ancestor.toRealPath();
            if (!realAncestor.startsWith(root))
                throw new IllegalArgumentException("检查点路径超出项目。");
            Path resolved = realAncestor.resolve(ancestor.relativize(file)).normalize();
            if (!resolved.startsWith(root) || Files.isSymbolicLink(resolved))
                throw new IllegalArgumentException("检查点不能恢复符号链接。");
            return resolved;
        } catch (IOException error) {
            throw new IllegalArgumentException("检查点路径超出项目。", error);
        }
    }

    private Path safeFile(String relativePath) {
        Path relative = Path.of(relativePath);
        if (relative.isAbsolute() || relative.getRoot() != null)
            throw new IllegalArgumentException("检查点路径无效。");
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root) || file.equals(root))
            throw new IllegalArgumentException("检查点路径超出项目。");
        try {
            Path parent = file.getParent().toRealPath();
            if (!parent.startsWith(root))
                throw new IllegalArgumentException("检查点路径超出项目。");
            Path resolved = parent.resolve(file.getFileName().toString());
            if (Files.isSymbolicLink(resolved))
                throw new IllegalArgumentException("检查点不能恢复符号链接。");
            return resolved;
        } catch (IOException error) {
            throw new IllegalArgumentException("检查点路径超出项目。", error);
        }
    }

    private void save(Checkpoint checkpoint) {
        try {
            Path temporary = Files.createTempFile(directory, "checkpoint-", ".tmp");
            try {
                JSON.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), checkpoint);
                Files.move(
                        temporary,
                        file(checkpoint.id()),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(
                        temporary,
                        file(checkpoint.id()),
                        StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法保存项目检查点。", error);
        }
    }

    private void saveChangeSet(ChangeSet changeSet) {
        try {
            Path temporary = Files.createTempFile(changeSetDirectory, "change-set-", ".tmp");
            try {
                JSON.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), changeSet);
                Files.move(
                        temporary,
                        changeSetDirectory.resolve(changeSet.id() + ".json"),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(
                        temporary,
                        changeSetDirectory.resolve(changeSet.id() + ".json"),
                        StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法保存整组恢复记录。", error);
        }
    }

    private Path file(String id) {
        return directory.resolve(id + ".json");
    }

    private static void validateId(String id) {
        if (id == null || !id.matches("[a-f0-9-]{36}"))
            throw new IllegalArgumentException("检查点标识无效。");
    }

    private static void validateIdentity(String id) {
        if (id == null || !id.matches("[A-Za-z0-9._-]{1,120}")
                || id.equals(".") || id.equals(".."))
            throw new IllegalArgumentException("任务或会话标识无效。");
    }

    static String hash(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("无法计算文件哈希。", error);
        }
    }
}
