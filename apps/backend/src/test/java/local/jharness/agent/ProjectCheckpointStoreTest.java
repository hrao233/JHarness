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

    @Test
    void previewsAndRestoresAWholeRunWithoutOverwritingLaterUserEdits() throws Exception {
        Path project = Files.createDirectories(temporary.resolve("project-run"));
        Path workspace = Files.createDirectories(temporary.resolve("workspace-run"));
        Path first = project.resolve("first.txt");
        Path second = project.resolve("second.txt");
        Path created = project.resolve("created.txt");
        write(first, "FIRST-BEFORE");
        write(second, "SECOND-BEFORE");
        var store = new ProjectCheckpointStore(workspace, project);
        String sessionId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();

        store.run(sessionId, runId, "edit_file", "first.txt", () -> {
            write(first, "FIRST-MIDDLE");
            return ToolResultBlock.success("edited");
        });
        store.run(sessionId, runId, "edit_file", "first.txt", () -> {
            write(first, "FIRST-AFTER");
            return ToolResultBlock.success("edited");
        });
        store.run(sessionId, runId, "edit_file", "second.txt", () -> {
            write(second, "SECOND-AFTER");
            return ToolResultBlock.success("edited");
        });
        store.run(sessionId, runId, "create_file", "created.txt", () -> {
            write(created, "CREATED");
            return ToolResultBlock.success("created");
        });

        var preview = store.previewRun(sessionId, runId);
        assertTrue(preview.canRestore());
        assertEquals(4, preview.checkpointCount());
        assertEquals(3, preview.files().size());
        assertEquals(2, preview.files().stream()
                .filter(file -> file.path().equals("first.txt"))
                .findFirst().orElseThrow().checkpointCount());

        write(second, "USER-EDIT");
        var conflicted = store.previewRun(sessionId, runId);
        assertFalse(conflicted.canRestore());
        assertEquals(java.util.List.of("second.txt"), conflicted.conflicts());
        assertThrows(IllegalStateException.class, () -> store.restoreRun(sessionId, runId));
        assertEquals("FIRST-AFTER", Files.readString(first));
        assertTrue(Files.exists(created));

        write(second, "SECOND-AFTER");
        var restored = store.restoreRun(sessionId, runId);
        assertEquals(ProjectCheckpointStore.ChangeSetStatus.RESTORED, restored.status());
        assertEquals("FIRST-BEFORE", Files.readString(first));
        assertEquals("SECOND-BEFORE", Files.readString(second));
        assertFalse(Files.exists(created));
        assertEquals(1, store.changeSets(sessionId, runId).size());
        assertThrows(IllegalArgumentException.class,
                () -> store.restoreRun(sessionId, runId));
    }

    @Test
    void largeEditsRoundTripThroughApprovalAndBothRestorePaths() throws Exception {
        var root = Files.createDirectory(temporary.resolve("project"));
        var store = new ProjectCheckpointStore(temporary.resolve("workspace"), root);
        Path file = root.resolve("large.txt");
        String before = "\ufeff" + "示例行\r\n".repeat(12_000) + "目标\r\n";
        String after = before.replace("目标", "已改");
        write(file, before);
        var tools = new ProjectTools(root, (op, path, oldText, newText, denied, action) -> {
            assertEquals("目标\r\n", oldText);
            assertEquals("已改\r\n", newText);
            return store.run("session", "run", op, path, action);
        });
        for (boolean grouped : java.util.List.of(false, true)) {
            assertEquals("SUCCESS", tools.edit("large.txt", "目标\n", "已改\n").getState().name());
            assertEquals(after, Files.readString(file));
            var id = store.list("session").get(0).id();
            assertEquals(before, store.get(id).before().text());
            write(file, after + "手工修改");
            assertThrows(IllegalStateException.class, () -> store.restore(id));
            assertThrows(IllegalStateException.class, () -> store.restoreRun("session", "run"));
            assertEquals(after + "手工修改", Files.readString(file));
            write(file, after);
            if (grouped) store.restoreRun("session", "run");
            else store.restore(id);
            assertEquals(before, Files.readString(file));
        }
        var stale = new ProjectTools(root, (op, path, oldText, newText, denied, action) -> {
            write(file, "manual" + before);
            return action.get();
        });
        assertEquals("ERROR", stale.edit("large.txt", "目标", "已改").getState().name());
        assertEquals("manual" + before, Files.readString(file));
    }

    @Test
    void enforcesUtf8ByteLimitBeforeAndAfterAnEdit() throws Exception {
        Path file = temporary.resolve("edge.txt");
        String original = "a".repeat(8 * 1024 * 1024 - 3) + "尾";
        write(file, original);
        var tools = new ProjectTools(temporary, (op, path, before, after, denied, action) -> action.get());
        assertEquals("ERROR", tools.edit("edge.txt", "尾", "尾!").getState().name());
        assertEquals("ERROR", tools.edit("edge.txt", "aa", "x").getState().name());
        assertEquals("SUCCESS", tools.edit("edge.txt", "尾", "首").getState().name());
        write(file, original + "!");
        assertEquals("ERROR", tools.edit("edge.txt", "尾", "").getState().name());
        assertEquals(original + "!", Files.readString(file));
        assertEquals("ERROR", tools.create("new.txt", "a".repeat(65537)).getState().name());
    }

    private static void write(Path file, String text) {
        try {
            Files.writeString(file, text, StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
