package local.jharness;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Base64Source;
import io.agentscope.core.message.ContentBlock;
import io.agentscope.core.message.ImageBlock;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import io.agentscope.core.model.ModelCreationContext;
import io.agentscope.core.model.ModelRegistry;
import io.agentscope.core.session.SessionViews;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import local.jharness.agent.ConversationRuntime;
import local.jharness.memory.ProjectMemory;

public final class Backend {
    private static final String USER_ID = "local";

    private final ObjectMapper json = new ObjectMapper();
    private final PrintStream protocol;
    private final Object bookmarkLock = new Object();
    private final Path dataDirectory;
    private final ConversationRuntime conversations = new ConversationRuntime(this::event, Backend::describe);

    private record ChatMessage(String id, String role, String text, String timestamp, int turn) {}
    private record Bookmark(String id, String projectId, String sessionId, String messageId,
            int turn, String role, String text) {}
    private record SearchMatch(String projectId, String sessionId, String messageId, String excerpt) {}

    private Backend(PrintStream protocol, Path dataDirectory) {
        this.protocol = protocol;
        this.dataDirectory = dataDirectory;
    }

    public static void main(String[] args) throws Exception {
        var protocol = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        System.setOut(System.err);
        var backend = new Backend(protocol, Path.of(args[0]).toAbsolutePath().normalize());
        Files.createDirectories(backend.dataDirectory);
        backend.run();
    }

    private void run() throws Exception {
        var workers = Executors.newFixedThreadPool(2);
        try (var reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                var request = json.readTree(line);
                if (request.path("method").asText().equals("stop")) {
                    String runId = request.path("params").path("runId").asText();
                    conversations.stop(runId);
                    send(Map.of("id", request.path("id").asText(), "result", true));
                } else {
                    workers.submit(() -> handle(request));
                }
            }
        } finally {
            conversations.close();
            workers.shutdownNow();
        }
    }

    private void handle(JsonNode request) {
        String id = request.path("id").asText();
        JsonNode params = request.path("params");
        try {
            Object result = switch (request.path("method").asText()) {
                case "ping" -> Map.of("version", "0.1.0");
                case "testModel" -> testModel(params);
                case "history" -> history(params);
                case "memoryList" -> projectMemory(params).list(memoryContext());
                case "memoryRead" -> projectMemory(params).read(memoryContext(), required(params, "name"),
                        params.path("archive").asBoolean());
                case "memorySearch" -> projectMemory(params).search(memoryContext(), required(params, "query"));
                case "memoryUpdate" -> updateMemory(params);
                case "searchSessions" -> searchSessions(params);
                case "listBookmarks" -> listBookmarks();
                case "addBookmark" -> addBookmark(params);
                case "removeBookmark" -> removeBookmark(params);
                case "importBookmarks" -> importBookmarks(params);
                case "chat" -> startChat(params);
                case "approve" -> conversations.approve(identifier(params, "runId"),
                        identifier(params, "approvalId"), params.path("allow").asBoolean(false));
                default -> throw new IllegalArgumentException("未知操作。");
            };
            send(Map.of("id", id, "result", result));
        } catch (Exception error) {
            send(Map.of("id", id, "error", describe(error)));
        }
    }

    private Object testModel(JsonNode params) {
        var message = Msg.builder().role(MsgRole.USER)
                .content(TextBlock.builder().text("Reply with OK.").build()).build();
        Model model = model(params);
        boolean received = model.stream(List.of(message), List.of(),
                        GenerateOptions.builder().build())
                .any(chunk -> chunk.getContent().stream().anyMatch(TextBlock.class::isInstance))
                .block(Duration.ofSeconds(25));
        if (!received) {
            throw new IllegalStateException("模型没有返回内容。");
        }
        return Map.of("model", model.getModelName());
    }

    private List<ChatMessage> history(JsonNode params) throws Exception {
        var context = context(params);
        var log = ConversationRuntime.openSession(workspace(params), context);
        var history = new ArrayList<ChatMessage>();
        int turn = 0;
        for (Msg message : SessionViews.transcript(log).messages()) {
            boolean user = message.getRole() == MsgRole.USER;
            if ((!user && message.getRole() != MsgRole.ASSISTANT) || message.getTextContent().isBlank()) continue;
            if (user) turn++;
            String text = user && message.getMetadata() != null
                    && message.getMetadata().get("jharnessDisplay") instanceof String display
                    ? display : message.getTextContent();
            history.add(new ChatMessage(message.getId(), user ? "user" : "assistant", text,
                    message.getTimestamp(), turn));
        }
        return history;
    }

    private List<SearchMatch> searchSessions(JsonNode params) throws Exception {
        String query = required(params, "query").toLowerCase(Locale.ROOT);
        var results = new ArrayList<SearchMatch>();
        for (JsonNode session : params.path("sessions")) {
            String projectId = identifier(session, "projectId");
            String sessionId = identifier(session, "sessionId");
            if (session.path("title").asText().toLowerCase(Locale.ROOT).contains(query)
                    || session.path("projectName").asText().toLowerCase(Locale.ROOT).contains(query)) {
                results.add(new SearchMatch(projectId, sessionId, null, ""));
            } else {
                for (ChatMessage message : history(session)) {
                    String text = message.text();
                    int index = text.toLowerCase(Locale.ROOT).indexOf(query);
                    if (index < 0) continue;
                    int start = Math.min(text.length(), Math.max(index - 28, 0));
                    int end = Math.min(text.length(), start + 125);
                    String excerpt = (start > 0 ? "…" : "") + text.substring(start, end).strip()
                            + (end < text.length() ? "…" : "");
                    results.add(new SearchMatch(projectId, sessionId, message.id(), excerpt));
                    break;
                }
            }
            if (results.size() == 100) break;
        }
        return results;
    }

    private List<Bookmark> listBookmarks() throws Exception {
        Path file = dataDirectory.resolve("bookmarks.json");
        if (!Files.exists(file)) return new ArrayList<>();
        return json.readValue(file.toFile(), new TypeReference<ArrayList<Bookmark>>() {});
    }

    private void saveBookmarks(List<Bookmark> bookmarks) throws Exception {
        Path file = dataDirectory.resolve("bookmarks.json");
        Path temporary = Files.createTempFile(dataDirectory, "bookmarks-", ".tmp");
        try {
            json.writeValue(temporary.toFile(), bookmarks);
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private List<Bookmark> addBookmark(JsonNode params) throws Exception {
        String messageId = required(params, "messageId");
        ChatMessage message = history(params).stream().filter(item -> item.id().equals(messageId))
                .findFirst().orElseThrow(() -> new IllegalArgumentException("找不到已保存的消息。"));
        String projectId = identifier(params, "projectId");
        String sessionId = identifier(params, "sessionId");
        synchronized (bookmarkLock) {
            var bookmarks = listBookmarks();
            if (bookmarks.stream().noneMatch(item -> item.projectId().equals(projectId)
                    && item.sessionId().equals(sessionId) && messageId.equals(item.messageId()))) {
                bookmarks.add(0, toBookmark(UUID.randomUUID().toString(), projectId, sessionId, message));
                saveBookmarks(bookmarks);
            }
            return bookmarks;
        }
    }

    private List<Bookmark> removeBookmark(JsonNode params) throws Exception {
        String id = identifier(params, "id");
        synchronized (bookmarkLock) {
            var bookmarks = listBookmarks();
            if (bookmarks.removeIf(item -> id.equals(item.id()))) saveBookmarks(bookmarks);
            return bookmarks;
        }
    }

    private boolean importBookmarks(JsonNode params) throws Exception {
        synchronized (bookmarkLock) {
            var bookmarks = listBookmarks();
            int count = bookmarks.size();
            for (JsonNode item : params.path("bookmarks")) {
                String id = identifier(item, "id");
                if (bookmarks.stream().anyMatch(bookmark -> id.equals(bookmark.id()))) continue;
                String projectId = identifier(item, "projectId");
                String sessionId = identifier(item, "sessionId");
                int turn = item.path("turn").asInt();
                String role = required(item, "role");
                String text = item.path("text").asText();
                var message = history(item).stream().filter(value -> value.turn() == turn
                        && role.equals(value.role()) && text.equals(value.text())).findFirst();
                bookmarks.add(message.map(value -> toBookmark(id, projectId, sessionId, value))
                        .orElseGet(() -> new Bookmark(id, projectId, sessionId, null, turn, role, text)));
            }
            if (bookmarks.size() != count) saveBookmarks(bookmarks);
            return true;
        }
    }

    private static Bookmark toBookmark(String id, String projectId, String sessionId, ChatMessage message) {
        return new Bookmark(id, projectId, sessionId, message.id(), message.turn(), message.role(), message.text());
    }

    private boolean startChat(JsonNode params) throws Exception {
        String runId = identifier(params, "runId");
        var context = RuntimeContext.builder(context(params)).runId(runId).build();
        var project = Path.of(required(params, "projectPath")).toRealPath();
        var message = userMessage(params);
        var model = model(params);
        String permission = params.path("permission").asText("assist");
        boolean autoMemory = params.path("autoMemory").asBoolean();
        Model auxiliary = autoMemory || permission.equals("assist") ? model(params, true) : model;
        conversations.start(new ConversationRuntime.Request(workspace(params), project, context, message,
                required(params, "message"), model, auxiliary, autoMemory, permission));
        return true;
    }

    private Msg userMessage(JsonNode params) {
        String text = required(params, "message");
        var blocks = new ArrayList<ContentBlock>();
        blocks.add(TextBlock.builder().text(text).build());
        var labels = new ArrayList<String>();
        for (JsonNode part : params.path("parts")) {
            String label = required(part, "label");
            labels.add(label);
            if (part.hasNonNull("image")) {
                var source = Base64Source.builder().mediaType(required(part, "mime"))
                        .data(required(part, "image")).build();
                blocks.add(TextBlock.builder().text("[" + label + "]").build());
                blocks.add(ImageBlock.builder().source(source).build());
            } else {
                String kind = part.path("kind").asText();
                String role = List.of("skill", "plugin").contains(kind)
                        ? "用户为本次请求选择的工作指引" : "用户提供的参考资料";
                blocks.add(TextBlock.builder().text("[" + role + " · " + label + "]\n" + required(part, "text")).build());
            }
        }
        String display = labels.isEmpty() ? text : text + "\n\n" + String.join(" · ", labels);
        return Msg.builder().id(identifier(params, "runId")).role(MsgRole.USER).content(blocks)
                .metadata(Map.of("jharnessDisplay", display)).build();
    }

    private Path workspace(JsonNode params) throws Exception {
        return Files.createDirectories(dataDirectory.resolve(identifier(params, "projectId")));
    }

    private ProjectMemory projectMemory(JsonNode params) throws Exception {
        return new ProjectMemory(workspace(params));
    }

    private RuntimeContext memoryContext() {
        return RuntimeContext.builder().userId(USER_ID).build();
    }

    private boolean updateMemory(JsonNode params) throws Exception {
        return conversations.whileIdle(() -> {
            if (!params.path("text").isTextual() || !params.path("expected").isTextual()) {
                throw new IllegalArgumentException("缺少记忆正文或原始版本。");
            }
            String text = params.path("text").asText();
            if (text.length() > 25000) throw new IllegalArgumentException("项目记忆最多 25,000 字符。");
            projectMemory(params).update(memoryContext(), params.path("expected").asText(), text);
            return true;
        });
    }

    private RuntimeContext context(JsonNode params) {
        return RuntimeContext.builder().userId(USER_ID).sessionId(identifier(params, "sessionId")).build();
    }

    private Model model(JsonNode params) {
        return model(params, false);
    }

    private Model model(JsonNode params, boolean reviewer) {
        String key = required(params, "key");
        var context = ModelCreationContext.builder().apiKey(key).stream(true);
        String effort = reviewer ? "default" : params.path("effort").asText("default");
        String speed = reviewer ? "" : params.path("serviceTier").asText("");
        boolean deepseek = params.path("provider").asText().equals("deepseek");
        if (!List.of("", "fast", "priority").contains(speed) || (deepseek && !speed.isEmpty())) {
            throw new IllegalArgumentException("此模型配置不支持快速模式。");
        }
        var options = GenerateOptions.builder();
        String id;
        if (deepseek) {
            id = "deepseek:" + required(params, "model");
            context.baseUrl(params.path("baseUrl").asText("https://api.deepseek.com"));
            if (!List.of("default", "none", "low", "high", "max").contains(effort)) {
                throw new IllegalArgumentException("无效的 DeepSeek 推理强度。");
            }
            if (reviewer || !effort.equals("default")) context.enableThinking(!reviewer && !effort.equals("none"));
        } else {
            URI base = URI.create(required(params, "baseUrl"));
            if (!List.of("https", "http").contains(base.getScheme()) || base.getHost() == null
                    || base.getUserInfo() != null || base.getQuery() != null || base.getFragment() != null) {
                throw new IllegalArgumentException("请输入有效的 HTTP 或 HTTPS Base URL。");
            }
            id = "openai:" + required(params, "model");
            context.baseUrl(base.toString()).endpointPath("/chat/completions");
            if (!List.of("default", "none", "minimal", "low", "medium", "high", "xhigh", "max").contains(effort)) {
                throw new IllegalArgumentException("无效的兼容接口推理强度。");
            }
        }
        if (!effort.equals("default") && !(deepseek && effort.equals("none"))) options.reasoningEffort(effort);
        if (!speed.isEmpty()) options.additionalBodyParam("service_tier", speed);
        context.component(GenerateOptions.class, options.build());
        var settings = context.build();
        try {
            return ModelRegistry.resolve(id, settings);
        } finally {
            ModelRegistry.evictResolvedCache(settings, id);
        }
    }

    private static String identifier(JsonNode params, String field) {
        String value = required(params, field);
        if (!value.matches("[a-f0-9-]{36}")) {
            throw new IllegalArgumentException("无效的项目、会话或任务标识。");
        }
        return value;
    }

    private static String required(JsonNode params, String field) {
        String value = params.path(field).asText().strip();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("缺少必要信息。");
        }
        return value;
    }

    private static String describe(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            String text = String.valueOf(current.getMessage()).toLowerCase(Locale.ROOT);
            if (text.contains("explicit reconciliation required")) {
                return "此会话有中断前已提交但结果未确认的工具调用。为避免重复执行，请先检查工作区，再在新会话继续。";
            }
            if (text.contains("401") || text.contains("403")) return "服务商拒绝了请求，请检查 API Key 和权限。";
            if (text.contains("404") || text.contains("model_not_found")) return "找不到模型或接口，请检查模型 ID 和 Base URL。";
            if (text.contains("429")) return "服务商限流，请稍后重试。";
            if (text.contains("402")) return "服务商返回余额或额度错误。";
            if (text.contains("service_tier") || text.contains("service tier")) {
                return "服务商拒绝了快速档位，请检查模型、账户权限和快速模式配置。";
            }
            if (text.contains("reasoning_effort") || text.contains("reasoning effort")) {
                return "服务商拒绝了推理强度，请修改模型配置或使用默认档位。";
            }
            if (text.contains("timed out") || text.contains("timeout")) return "连接超时，请检查网络和服务地址。";
            if (text.contains("refused") || text.contains("unknownhost") || text.contains("connectexception")) {
                return "无法连接模型服务，请检查网络和服务地址。";
            }
        }
        return error instanceof IllegalArgumentException
                ? "请求无效，请检查模型设置或项目路径。"
                : "请求失败，请检查模型设置和项目是否可访问。";
    }

    private void event(String runId, String type, Object data) {
        send(Map.of("event", type, "runId", runId, "data", data));
    }

    private synchronized void send(Object response) {
        try {
            protocol.println(json.writeValueAsString(response));
        } catch (Exception error) {
            throw new IllegalStateException("Cannot encode protocol response", error);
        }
    }
}
