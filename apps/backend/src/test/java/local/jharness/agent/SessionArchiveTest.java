package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionKey;
import io.agentscope.core.util.JsonUtils;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionArchiveTest {
    @TempDir Path temporary;

    @Test
    void inspectsAndExportsALongSessionWithinTheLocalBudget() {
        String sessionId = UUID.randomUUID().toString();
        RuntimeContext context = RuntimeContext.builder()
                .userId("local")
                .sessionId(sessionId)
                .build();
        var log = new WorkspaceSessionLogStore(new LocalFilesystem(temporary))
                .open(new SessionKey("local", "jharness", sessionId), context);
        var events = new ArrayList<SessionEvent>();
        for (int i = 0; i < 1200; i++) {
            var message = Msg.builder()
                    .id("long-" + i)
                    .role(MsgRole.USER)
                    .content(TextBlock.builder().text("LONG-SESSION-" + i).build())
                    .build();
            events.add(event(
                    i + 1,
                    "message/user",
                    Map.of("message", message)));
        }
        var latestMessages = events.subList(1195, 1200).stream()
                .map(event -> event.data().get("message"))
                .toList();
        events.add(event(
                1201,
                "request/prepared",
                Map.of(
                        "model", "fixture-model",
                        "purpose", "conversation",
                        "messages", latestMessages,
                        "tools", List.of(Map.of("function", Map.of("name", "read_file"))),
                        "options", Map.of())));
        var writer = log.acquire("long-session", Duration.ofMinutes(1));
        try {
            log.commit(writer, "long-session", 0, events);
        } finally {
            log.release(writer);
        }

        long started = System.nanoTime();
        var snapshot = SessionArchive.inspect(log, sessionId);
        var markdown = SessionArchive.export(log, sessionId, "Long session", "markdown");
        var json = SessionArchive.export(log, sessionId, "Long session", "json");
        long elapsedMillis = Duration.ofNanos(System.nanoTime() - started).toMillis();

        assertEquals(1200, snapshot.transcriptMessages());
        assertEquals(5, snapshot.lastRequest().messageCount());
        assertTrue(markdown.content().contains("LONG-SESSION-1199"));
        assertTrue(json.content().contains("\"events\""));
        assertTrue(elapsedMillis < 5000, "long-session inspection/export took " + elapsedMillis + "ms");
    }

    private static SessionEvent event(long seq, String type, Map<String, Object> data) {
        return new SessionEvent(
                1,
                UUID.randomUUID().toString(),
                seq,
                System.currentTimeMillis(),
                type,
                "run-long",
                "turn-long",
                true,
                JsonUtils.getJsonCodec().toJson(data));
    }
}
