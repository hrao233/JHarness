package local.jharness.search;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionSearchIndexTest {
    @TempDir Path temporary;

    @Test
    void indexesLatinWordsAndCjkBigramsAndSkipsUnchangedSessions() {
        var index = new SessionSearchIndex(temporary.resolve("search.sqlite"));
        String sessionId = UUID.randomUUID().toString();
        var messages = List.of(
                message(sessionId, "m1", 1, "请修复认证模块的中文错误"),
                message(sessionId, "m2", 2, "Fix browser search in Edge"),
                message(sessionId, "m3", 3, "Attachment fixture.png"));

        assertTrue(index.needsSync(sessionId, 10));
        index.sync(sessionId, 10, messages);
        assertFalse(index.needsSync(sessionId, 10));

        assertEquals("m1", index.search("认证模块", Set.of(sessionId)).get(0).messageId());
        assertEquals("m2", index.search("browser search", Set.of(sessionId)).get(0).messageId());
        assertEquals("m3", index.search("fixture.png", Set.of(sessionId)).get(0).messageId());
        assertEquals(
                List.of("c_认证", "c_证模", "c_模块"),
                SessionSearchIndex.tokens("认证模块"));
    }

    @Test
    void searchesFiveThousandMessagesWithinTheLocalBudget() {
        var index = new SessionSearchIndex(temporary.resolve("long-search.sqlite"));
        String sessionId = UUID.randomUUID().toString();
        var messages = new ArrayList<SessionSearchIndex.Message>();
        for (int i = 0; i < 5000; i++) {
            messages.add(message(
                    sessionId,
                    "long-" + i,
                    i / 2 + 1,
                    "message " + i + (i == 4321 ? " NEEDLE-4321" : " routine project text")));
        }
        index.sync(sessionId, 5000, messages);

        long started = System.nanoTime();
        var result = index.search("needle-4321", Set.of(sessionId));
        long elapsed = Duration.ofNanos(System.nanoTime() - started).toMillis();

        assertEquals("long-4321", result.get(0).messageId());
        assertTrue(elapsed < 2000, "5k-message FTS query took " + elapsed + "ms");
    }

    private static SessionSearchIndex.Message message(
            String sessionId, String id, int turn, String text) {
        return new SessionSearchIndex.Message(
                "project", sessionId, id, turn, turn % 2 == 0 ? "assistant" : "user", text);
    }
}
