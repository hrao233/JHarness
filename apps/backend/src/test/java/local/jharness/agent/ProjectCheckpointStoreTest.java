package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.agentscope.core.message.ToolResultBlock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProjectCheckpointStoreTest {
    @TempDir Path temporary;

    @Test
    void restoresOnlyWhenThePostCheckpointFileIsUnchanged() throws Exception {
        Path project = Files.createDirectories(temporary.resolve("project"));
        Path workspace = Files.createDirectories(temporary.resolve("workspace"));
        Path file = project.resolve("note.txt");
        Files.writeString(file, "BEFORE", StandardCharsets.UTF_8);
        var store = new ProjectCheckpointStore(workspace, project);
        String sessionId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();

        ToolResultBlock result = store.run(sessionId, runId, "edit_file", "note.txt", () -> {
            write(file, "AFTER");
            return ToolResultBlock.success("edited");
        });
        assertEquals("SUCCESS", result.getState().name());
        var summary = store.list(sessionId).get(0);
        var checkpoint = store.get(summary.id());
        assertEquals("BEFORE", checkpoint.before().text());
        assertEquals("AFTER", checkpoint.after().text());

        write(file, "USER EDIT");
        assertThrows(IllegalStateException.class, () -> store.restore(checkpoint.id()));
        write(file, "AFTER");
        var restored = store.restore(checkpoint.id());
        assertEquals(ProjectCheckpointStore.Status.RESTORED, restored.status());
        assertEquals("BEFORE", Files.readString(file));
        assertThrows(IllegalArgumentException.class, () -> store.restore(checkpoint.id()));
    }

    @Test
    void restoresCreatedFilesByDeletingThemAndRejectsLaterUserEdits() throws Exception {
        Path project = Files.createDirectories(temporary.resolve("project-create"));
        Path workspace = Files.createDirectories(temporary.resolve("workspace-create"));
        Path file = project.resolve("new.txt");
        var store = new ProjectCheckpointStore(workspace, project);
        String sessionId = UUID.randomUUID().toString();

        store.run(sessionId, UUID.randomUUID().toString(), "create_file", "new.txt", () -> {
            write(file, "CREATED");
            return ToolResultBlock.success("created");
        });
        assertThrows(IllegalArgumentException.class, () -> store.run(
                sessionId,
                UUID.randomUUID().toString(),
                "edit_file",
                "../outside.txt",
                () -> ToolResultBlock.success("must not run")));
        var checkpoint = store.get(store.list(sessionId).get(0).id());
        assertFalse(checkpoint.before().exists());
        store.restore(checkpoint.id());
        assertFalse(Files.exists(file));
    }

    private static void write(Path file, String text) {
        try {
            Files.writeString(file, text, StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
