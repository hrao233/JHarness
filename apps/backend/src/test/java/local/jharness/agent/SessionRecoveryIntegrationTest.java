package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.message.ToolResultState;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionKey;
import io.agentscope.core.session.SessionProjection;
import io.agentscope.core.session.SessionRecovery;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.util.JsonUtils;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionRecoveryIntegrationTest {
    @TempDir Path temporary;

    @Test
    void reconcilesAnUncertainToolOutcomeAndClearsTheRecoveryFlag() {
        String sessionId = UUID.randomUUID().toString();
        RuntimeContext context = RuntimeContext.builder()
                .userId("local")
                .sessionId(sessionId)
                .build();
        var store = new WorkspaceSessionLogStore(new LocalFilesystem(temporary));
        var log = store.open(new SessionKey("local", "jharness", sessionId), context);
        var writer = log.acquire("test", Duration.ofMinutes(1));
        try {
            log.commit(
                    writer,
                    "seed",
                    0,
                    List.of(
                            event(1, "state/checkpoint", Map.of(
                                    "stateJson", AgentState.builder().build().toJson(),
                                    "projectorVersion", 1)),
                            event(2, "tool/dispatch", Map.of("toolCallId", "call-1"))));
        } finally {
            log.release(writer);
        }

        assertTrue(SessionProjection.read(log).uncertainToolCalls().contains("call-1"));
        var outcome = ToolResultBlock.of(
                        "call-1",
                        "edit_file",
                        TextBlock.builder().text("用户核对：操作已完成。").build())
                .withState(ToolResultState.SUCCESS);
        SessionRecovery.reconcile(
                log, Map.of("call-1", outcome), "user_verified_after_interruption");

        var projection = SessionProjection.read(log);
        assertTrue(projection.uncertainToolCalls().isEmpty());
        var restored = projection.restore();
        assertNotNull(restored);
        var results = restored.getContext().stream()
                .flatMap(message -> message.getContentBlocks(ToolResultBlock.class).stream())
                .toList();
        assertEquals(1, results.size());
        assertEquals(ToolResultState.SUCCESS, results.get(0).getState());
    }

    private static SessionEvent event(long seq, String type, Map<String, Object> data) {
        return new SessionEvent(
                1,
                UUID.randomUUID().toString(),
                seq,
                System.currentTimeMillis(),
                type,
                "run-1",
                "turn-1",
                true,
                JsonUtils.getJsonCodec().toJson(data));
    }
}
