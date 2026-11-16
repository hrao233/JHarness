package local.jharness.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Durable approval facts stored beside the session data for one project workspace. */
public final class DurableApprovalStore {

    public enum Status {
        PENDING,
        APPROVED,
        DENIED,
        COMPLETED,
        CANCELLED,
        INTERRUPTED,
        DISMISSED
    }

    public record ApprovalRecord(
            String id,
            String runId,
            String operation,
            String path,
            String before,
            String after,
            long createdAt,
            Status status,
            Status interruptedFrom) {}

    private static final String FILE_NAME = "approvals.json";
    private final ObjectMapper json = new ObjectMapper();
    private final Path file;

    public DurableApprovalStore(Path workspace) {
        this.file = workspace.resolve(FILE_NAME);
    }

    public synchronized List<ApprovalRecord> list() throws IOException {
        if (!Files.exists(file)) {
            return List.of();
        }
        return List.copyOf(
                json.readValue(
                        file.toFile(), new TypeReference<ArrayList<ApprovalRecord>>() {}));
    }

    public synchronized boolean exists(String id) throws IOException {
        return list().stream().anyMatch(record -> record.id().equals(id));
    }

    public synchronized ApprovalRecord add(
            String id,
            String runId,
            String operation,
            String path,
            String before,
            String after)
            throws IOException {
        var records = new ArrayList<>(list());
        if (records.stream().anyMatch(record -> record.id().equals(id))) {
            throw new IllegalArgumentException("Duplicate approval id");
        }
        var record =
                new ApprovalRecord(
                        id,
                        runId,
                        operation,
                        path,
                        before,
                        after,
                        Instant.now().toEpochMilli(),
                        Status.PENDING,
                        null);
        records.add(record);
        save(records);
        return record;
    }

    public boolean decide(String id, boolean allow) throws IOException {
        return transition(id, allow ? Status.APPROVED : Status.DENIED, Status.PENDING);
    }

    public boolean complete(String id) throws IOException {
        return transition(id, Status.COMPLETED, Status.APPROVED);
    }

    public boolean cancelPending(String id) throws IOException {
        return transition(id, Status.CANCELLED, Status.PENDING);
    }

    public boolean cancelBeforeExecution(String id) throws IOException {
        return transition(id, Status.CANCELLED, Status.PENDING, Status.APPROVED);
    }

    public boolean dismiss(String id) throws IOException {
        return transition(id, Status.DISMISSED, Status.INTERRUPTED);
    }

    private synchronized boolean transition(String id, Status status, Status... allowed) throws IOException {
        var records = new ArrayList<>(list());
        var previous = List.of(allowed);
        for (int i = 0; i < records.size(); i++) {
            var record = records.get(i);
            if (record.id().equals(id) && previous.contains(record.status())) {
                records.set(i, withStatus(record, status));
                save(records);
                return true;
            }
        }
        return false;
    }

    public synchronized int recoverInterrupted() throws IOException {
        var records = new ArrayList<>(list());
        int changed = 0;
        for (int i = 0; i < records.size(); i++) {
            var record = records.get(i);
            if (record.status() == Status.PENDING || record.status() == Status.APPROVED) {
                records.set(i, withStatus(record, Status.INTERRUPTED));
                changed++;
            }
        }
        if (changed > 0) {
            save(records);
        }
        return changed;
    }

    private void save(List<ApprovalRecord> records) throws IOException {
        Path parent = file.getParent();
        Files.createDirectories(parent);
        Path temporary = Files.createTempFile(parent, "approvals-", ".tmp");
        try {
            json.writeValue(temporary.toFile(), records);
            try {
                Files.move(
                        temporary,
                        file,
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(
                        temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static ApprovalRecord withStatus(ApprovalRecord record, Status status) {
        return new ApprovalRecord(
                record.id(),
                record.runId(),
                record.operation(),
                record.path(),
                record.before(),
                record.after(),
                record.createdAt(),
                status,
                status == Status.INTERRUPTED ? record.status() : record.interruptedFrom());
    }
}
