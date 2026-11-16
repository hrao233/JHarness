package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DurableApprovalStoreTest {

    @TempDir Path workspace;

    @Test
    void interruptedApprovalSurvivesRestartAndCannotExecute() throws Exception {
        var first = new DurableApprovalStore(workspace);
        first.add("approval-1", "run-1", "edit_file", "README.md", "before", "after");

        var restarted = new DurableApprovalStore(workspace);
        assertEquals(1, restarted.recoverInterrupted());
        assertEquals(
                DurableApprovalStore.Status.INTERRUPTED,
                restarted.list().get(0).status());
        assertFalse(restarted.decide("approval-1", true));
        assertTrue(restarted.dismiss("approval-1"));
        assertEquals(
                DurableApprovalStore.Status.DISMISSED,
                new DurableApprovalStore(workspace).list().get(0).status());
    }

    @Test
    void pendingDenialIsPersistedBeforeTheToolCanRun() throws Exception {
        var store = new DurableApprovalStore(workspace);
        store.add("approval-2", "run-2", "run_command", "project", "", "echo test");

        assertTrue(store.decide("approval-2", false));
        assertFalse(new DurableApprovalStore(workspace).decide("approval-2", true));
        assertEquals(
                DurableApprovalStore.Status.DENIED,
                new DurableApprovalStore(workspace).list().get(0).status());
    }
}
