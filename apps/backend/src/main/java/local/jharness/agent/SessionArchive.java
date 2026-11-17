package local.jharness.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.Msg;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.session.SessionProjection;
import io.agentscope.core.session.SessionViews;
import io.agentscope.core.state.AgentState;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Read-only context inspection and immutable session branching over committed session logs. */
public final class SessionArchive {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern CONTEXT_ITEM = Pattern.compile(
            "<context_item\\s+kind=\"([^\"]+)\"\\s+source=\"([^\"]+)\"\\s+revision=\"([^\"]+)\"");
    private static final int MAX_PREVIEW = 240;
    private static final int MAX_MESSAGES = 32;
    private static final int MAX_ITEMS = 48;
    private static final Set<String> TRANSCRIPT_EVENTS = Set.of(
            "message/user", "message/assistant", "tool/result", "turn/output");

    public record ContextItem(String kind, String source, String revision) {}

    public record ContextMessage(
            String role, String name, String preview, List<ContextItem> items) {}

    public record RequestSnapshot(
            long seq,
            String model,
            String purpose,
            int messageCount,
            int toolCount,
            int characters,
            List<String> tools,
            List<ContextMessage> messages,
            Object manifest) {}

    public record BranchSource(
            String sourceSessionId,
            String sourceMessageId,
            long sourceSeq,
            long createdAt) {}

    public record ContextSnapshot(
            String sessionId,
            long asOfSeq,
            int transcriptMessages,
            int compactionCount,
            int checkpointCount,
            int pendingInteractions,
            int uncertainToolCalls,
            RequestSnapshot lastRequest,
            BranchSource branch) {}

    public record ForkResult(
            String branchSessionId,
            String sourceSessionId,
            String sourceMessageId,
            long sourceSeq,
            int events) {}

    public record ExportDocument(
            String format,
            String filename,
            String mime,
            String content,
            int messages,
            int events,
            boolean truncated) {}

    private static final int MAX_EXPORT_CHARACTERS = 16 * 1024 * 1024;

    private SessionArchive() {}

    public static ContextSnapshot inspect(SessionLog log, String sessionId) {
        long asOf = log.head().seq();
        int compactions = 0;
        int checkpoints = 0;
        Map<String, Object> latestRequest = null;
        long latestRequestSeq = 0;
        BranchSource branch = null;
        for (var event : log.scan(0, asOf)) {
            switch (event.type()) {
                case "compaction/end" -> compactions++;
                case "state/checkpoint", "migration/baseline" -> checkpoints++;
                case "request/prepared" -> {
                    latestRequest = event.data();
                    latestRequestSeq = event.seq();
                }
                case "presentation/hint" -> {
                    var data = event.data();
                    if ("session_branch".equals(data.get("kind"))
                            && data.get("sourceSessionId") instanceof String source) {
                        branch = new BranchSource(
                                source,
                                text(data.get("sourceMessageId")),
                                number(data.get("sourceSeq")),
                                number(data.get("createdAt")));
                    }
                }
                default -> {
                    // Other native events contribute counts already projected elsewhere.
                }
            }
        }
        var projection = SessionProjection.read(log);
        var transcript = SessionViews.transcript(log);
        return new ContextSnapshot(
                sessionId,
                asOf,
                transcript.messages().size(),
                compactions,
                checkpoints,
                projection.stateJson() == null ? 0 : io.agentscope.core.session.SessionInteractions
                        .pending(log)
                        .size(),
                projection.uncertainToolCalls().size(),
                requestSnapshot(latestRequestSeq, latestRequest),
                branch);
    }

    public static ForkResult fork(
            SessionLog source,
            SessionLog target,
            String branchSessionId,
            String sourceSessionId,
            String messageId) {
        if (target.head().seq() != 0)
            throw new IllegalArgumentException("目标会话已经包含数据，不能作为分叉目标。");
        boolean atHead = messageId == null || messageId.isBlank();
        long cutoff = atHead
                ? source.head().seq()
                : messageSequence(source, messageId);
        if (cutoff < 1) throw new IllegalArgumentException("此消息不可用于分叉。");
        var messages = messagesThrough(source, cutoff, atHead ? null : messageId);
        var state = AgentState.builder().sessionId(branchSessionId).context(messages).build();
        var copied = new ArrayList<SessionEvent>();
        copied.add(new SessionEvent(
                1,
                UUID.randomUUID().toString(),
                1,
                System.currentTimeMillis(),
                "migration/baseline",
                null,
                null,
                true,
                json(Map.of(
                        "stateJson",
                        state.toJson(),
                        "sourceSessionId",
                        sourceSessionId,
                        "sourceSeq",
                        cutoff))));
        var marker = new LinkedHashMap<String, Object>();
        marker.put("kind", "session_branch");
        marker.put("sourceSessionId", sourceSessionId);
        marker.put("sourceMessageId", messageId);
        marker.put("sourceSeq", cutoff);
        marker.put("createdAt", System.currentTimeMillis());
        copied.add(new SessionEvent(
                1,
                UUID.randomUUID().toString(),
                2,
                System.currentTimeMillis(),
                "presentation/hint",
                null,
                null,
                true,
                json(marker)));
        var writer =
                target.acquire("branch-" + UUID.randomUUID(), Duration.ofMinutes(2));
        try {
            target.commit(
                    writer,
                    "branch-" + UUID.randomUUID(),
                    0,
                    List.copyOf(copied));
        } finally {
            target.release(writer);
        }
        return new ForkResult(
                branchSessionId, sourceSessionId, messageId, cutoff, copied.size());
    }

    public static ExportDocument export(
            SessionLog log, String sessionId, String title, String format) {
        String normalized = format == null || format.isBlank() ? "markdown" : format;
        if (!List.of("markdown", "json").contains(normalized))
            throw new IllegalArgumentException("不支持的导出格式。");
        var transcript = SessionViews.transcript(log);
        var events = new ArrayList<SessionEvent>();
        for (var event : log.scan(0, log.head().seq())) events.add(event);
        String safeTitle = title == null || title.isBlank() ? sessionId : title.strip();
        StringBuilder content = new StringBuilder();
        if (normalized.equals("markdown")) {
            content.append("# ").append(safeTitle).append("\n\n");
            content.append("- 会话：`").append(sessionId).append("`\n");
            content.append("- 导出时间：").append(Instant.now()).append("\n");
            content.append("- 事件数：").append(events.size()).append("\n");
            content.append("- 消息数：").append(transcript.messages().size()).append("\n\n");
            for (var message : transcript.messages()) {
                content.append("## ")
                        .append(message.getRole().name().toLowerCase())
                        .append(" · ")
                        .append(message.getTimestamp())
                        .append("\n\n");
                if (message.getName() != null && !message.getName().isBlank())
                    content.append("`").append(message.getName()).append("`\n\n");
                content.append(message.getTextContent()).append("\n\n");
                ensureCapacity(content);
            }
        } else {
            var document = new LinkedHashMap<String, Object>();
            document.put("sessionId", sessionId);
            document.put("title", safeTitle);
            document.put("exportedAt", Instant.now().toString());
            document.put("asOfSeq", log.head().seq());
            var encoded = new ArrayList<Map<String, Object>>();
            for (var event : events) {
                var item = new LinkedHashMap<String, Object>();
                item.put("schemaVersion", event.schemaVersion());
                item.put("eventId", event.eventId());
                item.put("seq", event.seq());
                item.put("occurredAt", event.occurredAt());
                item.put("type", event.type());
                item.put("executionRunId", event.executionRunId());
                item.put("turnId", event.turnId());
                item.put("required", event.required());
                item.put("data", event.data());
                encoded.add(item);
                if (content.length() > MAX_EXPORT_CHARACTERS)
                    throw new IllegalArgumentException("会话导出超过 16 MiB，请拆分会话后重试。");
            }
            document.put("events", encoded);
            content.append(jsonPretty(document));
        }
        ensureCapacity(content);
        String extension = normalized.equals("markdown") ? "md" : "json";
        String filename = "jharness-" + sessionId.substring(0, Math.min(8, sessionId.length()))
                + "." + extension;
        String mime = normalized.equals("markdown") ? "text/markdown" : "application/json";
        return new ExportDocument(
                normalized,
                filename,
                mime,
                content.toString(),
                transcript.messages().size(),
                events.size(),
                false);
    }

    private static List<Msg> messagesThrough(SessionLog log, long cutoff, String messageId) {
        var messages = new LinkedHashMap<String, Msg>();
        for (var event : log.scan(0, cutoff)) {
            if (event.type().equals("migration/baseline")) {
                for (var message : baselineMessages(event)) {
                    messages.putIfAbsent(message.getId(), message);
                    if (event.seq() == cutoff && messageId != null
                            && messageId.equals(message.getId())) break;
                }
            } else if (TRANSCRIPT_EVENTS.contains(event.type())) {
                Object value = event.data().get("message");
                if (value != null) {
                    Msg message = JSON.convertValue(value, Msg.class);
                    if (event.type().equals("turn/output")) messages.put(message.getId(), message);
                    else messages.putIfAbsent(message.getId(), message);
                }
            }
        }
        return List.copyOf(messages.values());
    }

    private static List<Msg> baselineMessages(SessionEvent event) {
        Object state = event.data().get("stateJson");
        return state instanceof String value
                ? AgentState.fromJsonString(value).getContext() : List.of();
    }

    private static long messageSequence(SessionLog log, String messageId) {
        long found = 0;
        for (var event : log.scan(0, log.head().seq())) {
            if (found == 0 && event.type().equals("migration/baseline")) {
                if (baselineMessages(event).stream().anyMatch(message -> messageId.equals(message.getId())))
                    found = event.seq();
            } else if (TRANSCRIPT_EVENTS.contains(event.type())
                    && (found == 0 || event.type().equals("turn/output"))) {
                Object message = event.data().get("message");
                if (message instanceof Map<?, ?> value && messageId.equals(value.get("id")))
                    found = event.seq();
            }
        }
        return found;
    }

    private static RequestSnapshot requestSnapshot(
            long seq, Map<String, Object> request) {
        if (request == null) return null;
        var messages = new ArrayList<ContextMessage>();
        int characters = 0;
        if (request.get("messages") instanceof List<?> values) {
            for (Object value : values) {
                Msg message = JSON.convertValue(value, Msg.class);
                String preview = message.getTextContent().replaceAll("\\s+", " ").strip();
                characters += preview.length();
                if (messages.size() < MAX_MESSAGES) {
                    messages.add(new ContextMessage(
                            message.getRole().name().toLowerCase(),
                            message.getName(),
                            preview.substring(0, Math.min(MAX_PREVIEW, preview.length())),
                            contextItems(preview)));
                }
            }
        }
        var tools = new ArrayList<String>();
        if (request.get("tools") instanceof List<?> values) {
            for (Object value : values) {
                String name = toolName(value);
                if (!name.isBlank() && tools.size() < MAX_ITEMS) tools.add(name);
            }
        }
        return new RequestSnapshot(
                seq,
                text(request.get("model")),
                text(request.get("purpose")),
                request.get("messages") instanceof List<?> list ? list.size() : 0,
                request.get("tools") instanceof List<?> list ? list.size() : 0,
                characters,
                List.copyOf(tools),
                List.copyOf(messages),
                request.get("context_manifest"));
    }

    private static List<ContextItem> contextItems(String text) {
        if (!text.contains("<context_item")) return List.of();
        var result = new ArrayList<ContextItem>();
        var matcher = CONTEXT_ITEM.matcher(text);
        while (matcher.find() && result.size() < MAX_ITEMS) {
            result.add(new ContextItem(matcher.group(1), matcher.group(2), matcher.group(3)));
        }
        return List.copyOf(result);
    }

    private static String toolName(Object value) {
        if (!(value instanceof Map<?, ?> tool)) return "";
        Object function = tool.get("function");
        if (function instanceof Map<?, ?> nested) return text(nested.get("name"));
        return text(tool.get("name"));
    }

    private static String text(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static long number(Object value) {
        return value instanceof Number number ? number.longValue() : 0;
    }

    private static String json(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (Exception error) {
            throw new IllegalStateException("Cannot encode session branch marker", error);
        }
    }

    private static String jsonPretty(Object value) {
        try {
            return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(value);
        } catch (Exception error) {
            throw new IllegalStateException("Cannot encode session export", error);
        }
    }

    private static void ensureCapacity(StringBuilder content) {
        if (content.length() > MAX_EXPORT_CHARACTERS)
            throw new IllegalArgumentException("会话导出超过 16 MiB，请拆分会话后重试。");
    }
}
