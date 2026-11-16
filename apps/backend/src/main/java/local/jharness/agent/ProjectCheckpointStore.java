package local.jharness.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.ToolResultBlock;
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
import java.util.List;
import java.util.UUID;
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

    private static final ObjectMapper JSON = new ObjectMapper();
    private final Path root;
    private final Path directory;

    public ProjectCheckpointStore(Path workspace, Path project) throws IOException {
        root = project.toRealPath();
        directory = Files.createDirectories(workspace.resolve("checkpoints"));
    }

    public ToolResultBlock run(
            String sessionId,
            String runId,
            String operation,
            String relativePath,
            Supplier<ToolResultBlock> action) {
        String id = UUID.randomUUID().toString();
        Path file = safeFile(relativePath);
        long now = System.currentTimeMillis();
        var record = new Checkpoint(
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
        ToolResultBlock result;
        try {
            result = action.get();
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
                snapshot(file)));
        return result;
    }

    public List<Summary> list(String sessionId) {
        try (var files = Files.list(directory)) {
            var result = new ArrayList<Summary>();
            files.filter(path -> path.getFileName().toString().endsWith(".json"))
                    .limit(2000)
                    .forEach(path -> {
                        try {
                            var checkpoint = JSON.readValue(path.toFile(), Checkpoint.class);
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
            return List.copyOf(result.stream().limit(200).toList());
        } catch (IOException error) {
            throw new IllegalStateException("无法读取项目检查点。", error);
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
        Path file = safeFile(checkpoint.path());
        var current = snapshot(file);
        if (!current.equals(checkpoint.after()))
            throw new IllegalStateException("文件在检查点后已被修改或删除。为避免覆盖后续编辑，本次恢复已取消。");
        try {
            if (checkpoint.before().exists()) {
                Files.createDirectories(file.getParent());
                Path temporary = Files.createTempFile(file.getParent(), ".jharness-checkpoint-", ".tmp");
                try {
                    Files.writeString(temporary, checkpoint.before().text(), StandardCharsets.UTF_8);
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
            } else {
                Files.deleteIfExists(file);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法恢复检查点。", error);
        }
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

    private Snapshot snapshot(Path file) {
        if (!Files.isRegularFile(file)) return new Snapshot(false, "", "");
        try {
            if (Files.size(file) > 64 * 1024) return new Snapshot(false, "", "");
            String text = Files.readString(file, StandardCharsets.UTF_8);
            return new Snapshot(true, text, hash(text));
        } catch (IOException error) {
            return new Snapshot(false, "", "");
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

    private Path file(String id) {
        return directory.resolve(id + ".json");
    }

    private static void validateId(String id) {
        if (id == null || !id.matches("[a-f0-9-]{36}"))
            throw new IllegalArgumentException("检查点标识无效。");
    }

    private static String hash(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("无法计算文件哈希。", error);
        }
    }
}
