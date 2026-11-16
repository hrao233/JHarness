package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionKey;
import io.agentscope.core.session.SessionViews;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import java.io.InputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionArchiveMigrationTest {
    @TempDir Path temporary;

    @Test
    void readsExportsAndBranchesLegacyV1Events() throws Exception {
        var mapper = new ObjectMapper();
        var events = new ArrayList<SessionEvent>();
        try (InputStream input =
                getClass().getResourceAsStream("/compatibility/session-v1.json")) {
            var fixture = mapper.readTree(input);
            for (var value : fixture.path("events"))
                events.add(mapper.treeToValue(value, SessionEvent.class));
        }
        var store = new WorkspaceSessionLogStore(new LocalFilesystem(temporary));
        String sourceId = UUID.randomUUID().toString();
        var source = store.open(
                new SessionKey("local", "jharness", sourceId),
                RuntimeContext.builder().userId("local").sessionId(sourceId).build());
        var writer = source.acquire("migration", Duration.ofMinutes(1));
        try {
            source.commit(writer, "legacy-v1", 0, events);
        } finally {
            source.release(writer);
        }

        var snapshot = SessionArchive.inspect(source, sourceId);
        var export = SessionArchive.export(source, sourceId, "Legacy", "markdown");
        assertEquals(2, snapshot.transcriptMessages());
        assertTrue(export.content().contains("legacy answer"));

        String branchId = UUID.randomUUID().toString();
        var branch = store.open(
                new SessionKey("local", "jharness", branchId),
                RuntimeContext.builder().userId("local").sessionId(branchId).build());
        SessionArchive.fork(source, branch, branchId, sourceId, "legacy-user");
        var transcript = SessionViews.transcript(branch);
        assertEquals(1, transcript.messages().size());
        assertEquals("legacy question legacy question", transcript.messages().get(0).getTextContent());
    }
}
