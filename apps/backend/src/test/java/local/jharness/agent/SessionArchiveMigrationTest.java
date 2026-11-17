package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.middleware.ModelCallInput;
import io.agentscope.core.model.ChatResponse;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import io.agentscope.core.model.ToolSchema;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionKey;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.session.SessionProjection;
import io.agentscope.core.session.SessionRecorder;
import io.agentscope.core.session.SessionViews;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.memory.compaction.CompactionConfig;
import io.agentscope.harness.agent.memory.compaction.ConversationCompactor;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import reactor.core.publisher.Flux;

class SessionArchiveMigrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final String IMPORTED = "legacy-import";
    private static final String IMPORTED_USER = "legacy-import-user";
    private static final String IMPORTED_ASSISTANT = "legacy-import-assistant";

    @TempDir Path temporary;

    @Test
    void readsExportsAndBranchesLegacyV1Events() throws Exception {
        seed("legacy-native", "session-v1.json");
        var source = open("legacy-native");
        var transcript = SessionViews.transcript(source);
        assertEquals(List.of("legacy-user", "legacy-assistant"), ids(transcript.messages()));
        assertEquals("legacy display", transcript.messages().get(0).getMetadata().get("jharnessDisplay"));

        var snapshot = SessionArchive.inspect(source, "legacy-native");
        var markdown = SessionArchive.export(source, "legacy-native", "Legacy", "markdown");
        var exported = JSON.readTree(
                SessionArchive.export(source, "legacy-native", "Legacy", "json").content()).path("events");
        assertEquals(2, snapshot.transcriptMessages());
        assertTrue(markdown.content().contains("legacy answer"));
        assertEquals("legacy-event-2", exported.path(1).path("eventId").asText());
        assertEquals("legacy-run", exported.path(1).path("executionRunId").asText());
        assertEquals("legacy-turn", exported.path(1).path("turnId").asText());

        var fork = SessionArchive.fork(source, open("legacy-branch"),
                "legacy-branch", "legacy-native", "legacy-user");
        assertEquals(1, fork.sourceSeq());
        var branch = open("legacy-branch");
        assertEquals(
                List.of("legacy-user"), ids(SessionViews.transcript(branch).messages()));
        assertEquals("legacy-native", SessionArchive.inspect(branch, "legacy-branch").branch().sourceSessionId());
        assertEquals(transcript, SessionViews.transcript(open("legacy-native")));
    }

    @Test
    void branchesInsideAReopenedLegacyBaselineAndInsideTheBranch() throws Exception {
        seed(IMPORTED, "session-v1-baseline.json");

        var source = open(IMPORTED);
        var imported = SessionViews.transcript(source);
        assertEquals(List.of(IMPORTED_USER, IMPORTED_ASSISTANT), ids(imported.messages()));
        assertEquals("旧版摘要", SessionProjection.read(source).restore().getSummary());

        SessionArchive.fork(source, open("early"), "early", IMPORTED, IMPORTED_USER);
        assertEquals(List.of(IMPORTED_USER), ids(SessionViews.transcript(open("early")).messages()));

        SessionArchive.fork(source, open("middle"), "middle", IMPORTED, IMPORTED_ASSISTANT);
        var middle = open("middle");
        assertEquals(imported.messages(), SessionViews.transcript(middle).messages());
        assertEquals("middle", SessionProjection.read(middle).restore().getSessionId());
        assertEquals("", SessionProjection.read(middle).restore().getSummary());

        var fork = SessionArchive.fork(middle, open("nested"), "nested", "middle", IMPORTED_USER);
        var nested = open("nested");
        var provenance = SessionArchive.inspect(nested, "nested").branch();
        assertEquals(List.of(IMPORTED_USER), ids(SessionViews.transcript(nested).messages()));
        assertEquals("middle", provenance.sourceSessionId());
        assertEquals(IMPORTED_USER, provenance.sourceMessageId());
        assertEquals(1, fork.sourceSeq());
        assertEquals(fork.sourceSeq(), provenance.sourceSeq());
        assertEquals(imported, SessionViews.transcript(open(IMPORTED)));
    }

    @Test
    void compactsLegacyContextWithoutLosingOriginalMessagesOrBranchPoints() throws Exception {
        seed(IMPORTED, "session-v1-baseline.json");
        var source = open(IMPORTED);
        var context = context(IMPORTED);
        var recorder = new SessionRecorder(source, "post-import-turn");
        context.put(SessionRecorder.CONTEXT_KEY, recorder);
        var followUp = Msg.builder()
                .id("post-import-question")
                .role(MsgRole.USER)
                .content(TextBlock.builder().text("继续检查迁移后的上下文。").build())
                .build();
        var model = new Model() {
            @Override
            public Flux<ChatResponse> stream(
                    List<Msg> messages, List<ToolSchema> tools, GenerateOptions options) {
                return Flux.just(ChatResponse.builder()
                        .content(List.of(TextBlock.builder().text("已核对旧版两条消息。").build()))
                        .finishReason("stop")
                        .build());
            }

            @Override
            public String getModelName() {
                return "fixed-compaction-model";
            }
        };
        var config = CompactionConfig.builder()
                .triggerMessages(3)
                .keepMessages(1)
                .keepTokens(0)
                .flushBeforeCompact(false)
                .build();
        String summaryId;
        try {
            var state = recorder.initial().restore();
            recorder.start(List.of(followUp), state).block(TIMEOUT);
            state.contextMutable().add(followUp);
            recorder.checkpoint(state, "post_import_input").block(TIMEOUT);
            var compactor = new ConversationCompactor(
                    model, null, messages -> 100L * messages.size(), ignored -> 100L);
            var compacted = compactor
                    .compactIfNeeded(context, state.getContext(), config, "jharness", IMPORTED)
                    .block(TIMEOUT)
                    .orElseThrow();
            assertEquals(2, compacted.size());
            var summary = compacted.get(0);
            summaryId = summary.getId();
            assertEquals(ConversationCompactor.SUMMARY_MSG_NAME, summary.getName());
            assertEquals(List.of(IMPORTED_USER, IMPORTED_ASSISTANT),
                    summary.getMetadata().get("context.covered_messages"));
            state.contextMutable().clear();
            state.contextMutable().addAll(compacted);
            recorder.prepareModel(new ModelCallInput(
                    compacted, List.of(), GenerateOptions.builder().build(), model),
                    "post-import-model-call", "FORWARD", state).block(TIMEOUT);
            recorder.finish(state, "completed").block(TIMEOUT);
        } finally {
            recorder.close();
        }

        source = open(IMPORTED);
        var archive = SessionArchive.inspect(source, IMPORTED);
        var transcript = SessionViews.transcript(source);
        assertEquals(1, archive.compactionCount());
        assertEquals(2, archive.lastRequest().messageCount());
        assertEquals(ConversationCompactor.SUMMARY_MSG_NAME, archive.lastRequest().messages().get(0).name());
        assertEquals(List.of(summaryId, followUp.getId()),
                ids(SessionProjection.read(source).restore().getContext()));
        assertEquals(List.of(IMPORTED_USER, IMPORTED_ASSISTANT, followUp.getId(), summaryId),
                ids(transcript.messages()));

        SessionArchive.fork(source, open("before-compaction"),
                "before-compaction", IMPORTED, IMPORTED_ASSISTANT);
        var branch = open("before-compaction");
        assertEquals(transcript.messages().subList(0, 2), SessionViews.transcript(branch).messages());
        assertEquals(1, SessionArchive.inspect(branch, "before-compaction").branch().sourceSeq());
        assertEquals(transcript, SessionViews.transcript(open(IMPORTED)));
    }

    private void seed(String sessionId, String resource) throws Exception {
        var events = new ArrayList<SessionEvent>();
        try (var input = getClass().getResourceAsStream("/compatibility/" + resource)) {
            assertNotNull(input, resource);
            var fixture = JSON.readTree(input);
            for (var value : fixture.path("events"))
                events.add(JSON.treeToValue(value, SessionEvent.class));
        }
        var source = open(sessionId);
        var writer = source.acquire("migration", Duration.ofMinutes(1));
        try {
            source.commit(writer, resource, 0, events);
        } finally {
            source.release(writer);
        }
    }

    private SessionLog open(String sessionId) {
        return new WorkspaceSessionLogStore(new LocalFilesystem(temporary))
                .open(new SessionKey("local", "jharness", sessionId), context(sessionId));
    }

    private static RuntimeContext context(String sessionId) {
        return RuntimeContext.builder().userId("local").sessionId(sessionId).build();
    }

    private static List<String> ids(List<Msg> messages) {
        return messages.stream().map(Msg::getId).toList();
    }
}
