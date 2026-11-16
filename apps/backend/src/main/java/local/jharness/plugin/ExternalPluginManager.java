package local.jharness.plugin;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.tool.AgentTool;
import io.agentscope.core.tool.ToolBase;
import io.agentscope.core.tool.ToolCallParam;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.harness.plugin.PluginProcessHost;
import io.agentscope.harness.plugin.PluginProcessSpec;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import reactor.core.publisher.Mono;

/** Explicitly installed, process-isolated tool plugins. No project scanning occurs here. */
public final class ExternalPluginManager implements AutoCloseable {
    private static final String MANIFEST = "jharness-plugin.json";
    private static final ObjectMapper JSON = new ObjectMapper();

    public record ToolSpec(
            String name, String description, Map<String, Object> inputSchema, boolean readOnly) {}

    public record Definition(
            String id,
            String name,
            String version,
            String description,
            Path directory,
            Path executable,
            List<String> arguments,
            List<ToolSpec> tools) {}

    public record Status(
            String id,
            String name,
            String version,
            String description,
            String directory,
            boolean enabled,
            boolean running,
            String error,
            String diagnostics,
            List<ToolSpec> tools) {}

    private record Stored(String directory, boolean enabled) {}

    private final Path configFile;
    private final Map<String, PluginProcessHost> hosts = new LinkedHashMap<>();
    private final Map<String, String> errors = new LinkedHashMap<>();
    private final Object lock = new Object();

    public ExternalPluginManager(Path dataDirectory) {
        configFile = dataDirectory.resolve("external-plugins.json");
    }

    public List<Status> list() {
        synchronized (lock) {
            var result = new ArrayList<Status>();
            for (var stored : load()) {
                try {
                    var definition = definition(stored);
                    var host = hosts.get(definition.id());
                    result.add(new Status(
                            definition.id(),
                            definition.name(),
                            definition.version(),
                            definition.description(),
                            definition.directory().toString(),
                            stored.enabled(),
                            host != null && host.isAlive(),
                            errors.get(definition.id()),
                            host == null ? "" : host.diagnostics(),
                            definition.tools()));
                } catch (Exception error) {
                    String fallback = stripExtension(Path.of(stored.directory()).getFileName().toString());
                    result.add(new Status(
                            fallback,
                            fallback,
                            "",
                            "",
                            stored.directory(),
                            stored.enabled(),
                            false,
                            message(error),
                            "",
                            List.of()));
                }
            }
            return List.copyOf(result);
        }
    }

    public Status install(Path directory) {
        synchronized (lock) {
            try {
                var definition = definition(new Stored(directory.toString(), false));
                var plugins = new ArrayList<>(load());
                plugins.removeIf(item -> {
                    try {
                        return definition.id().equals(definition(item).id());
                    } catch (Exception ignored) {
                        return Path.of(item.directory()).equals(definition.directory());
                    }
                });
                plugins.add(new Stored(definition.directory().toString(), false));
                save(plugins);
                errors.remove(definition.id());
                return new Status(
                        definition.id(),
                        definition.name(),
                        definition.version(),
                        definition.description(),
                        definition.directory().toString(),
                        false,
                        false,
                        null,
                        "",
                        definition.tools());
            } catch (Exception error) {
                throw new IllegalArgumentException(message(error), error);
            }
        }
    }

    public Status setEnabled(String id, boolean enabled) {
        synchronized (lock) {
            var plugins = new ArrayList<>(load());
            boolean changed = false;
            for (int i = 0; i < plugins.size(); i++) {
                var stored = plugins.get(i);
                try {
                    if (!definition(stored).id().equals(id)) continue;
                    plugins.set(i, new Stored(stored.directory(), enabled));
                    changed = true;
                } catch (Exception error) {
                    errors.put(id, message(error));
                }
            }
            if (!changed) throw new IllegalArgumentException("找不到插件。");
            save(plugins);
            if (!enabled) closeHost(id);
            return list().stream()
                    .filter(item -> item.id().equals(id))
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("找不到插件。"));
        }
    }

    public boolean uninstall(String id) {
        synchronized (lock) {
            var plugins = new ArrayList<>(load());
            boolean removed = plugins.removeIf(item -> {
                try {
                    return definition(item).id().equals(id);
                } catch (Exception ignored) {
                    return false;
                }
            });
            if (!removed) return false;
            closeHost(id);
            errors.remove(id);
            save(plugins);
            return true;
        }
    }

    public List<AgentTool> tools() {
        synchronized (lock) {
            var result = new ArrayList<AgentTool>();
            var names = new LinkedHashSet<String>();
            for (var stored : load()) {
                if (!stored.enabled()) continue;
                try {
                    var definition = definition(stored);
                    for (var tool : definition.tools())
                        if (!names.add(tool.name()))
                            throw new IllegalArgumentException("工具名称重复：" + tool.name());
                    var host = start(definition);
                    for (var tool : definition.tools())
                        result.add(new ProcessTool(definition.id(), tool, host));
                    errors.remove(definition.id());
                } catch (Exception error) {
                    String id = pluginId(stored);
                    errors.put(id, message(error));
                }
            }
            return List.copyOf(result);
        }
    }

    private PluginProcessHost start(Definition definition) {
        var existing = hosts.get(definition.id());
        if (existing != null && existing.isAlive()) return existing;
        if (existing != null) existing.close();
        var spec = new PluginProcessSpec(
                definition.executable(),
                definition.arguments(),
                definition.directory(),
                Map.of("JHARNESS_PLUGIN_ID", definition.id()),
                Duration.ofSeconds(10),
                Duration.ofSeconds(30),
                Duration.ofSeconds(5));
        var host = PluginProcessHost.start(spec);
        hosts.put(definition.id(), host);
        return host;
    }

    private Definition definition(Stored stored) throws IOException {
        Path directory = Path.of(stored.directory()).toRealPath();
        Path manifest = directory.resolve(MANIFEST).toRealPath();
        if (!manifest.startsWith(directory))
            throw new IllegalArgumentException("插件清单超出安装目录。");
        JsonNode root = JSON.readTree(manifest.toFile());
        String id = required(root, "id");
        if (!id.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"))
            throw new IllegalArgumentException("插件 id 无效。");
        int apiVersion = root.path("apiVersion").asInt(1);
        if (apiVersion != 1) throw new IllegalArgumentException("不支持的插件 API 版本。");
        Path executable = resolveExecutable(directory, required(root, "executable"));
        var arguments = new ArrayList<String>();
        for (var argument : root.path("arguments"))
            arguments.add(argument.asText());
        var tools = new ArrayList<ToolSpec>();
        for (var tool : root.path("tools")) {
            String name = required(tool, "name");
            if (!name.matches("[a-zA-Z][a-zA-Z0-9_]{1,63}"))
                throw new IllegalArgumentException("插件工具名称无效：" + name);
            if (!tool.path("inputSchema").isObject())
                throw new IllegalArgumentException("插件工具缺少 inputSchema：" + name);
            @SuppressWarnings("unchecked")
            Map<String, Object> schema = JSON.convertValue(tool.path("inputSchema"), Map.class);
            @SuppressWarnings("unchecked")
            Map<String, Object> frozenSchema =
                    java.util.Collections.unmodifiableMap(new LinkedHashMap<>(schema));
            tools.add(new ToolSpec(
                    name,
                    tool.path("description").asText(""),
                    frozenSchema,
                    tool.path("readOnly").asBoolean(false)));
        }
        if (tools.isEmpty()) throw new IllegalArgumentException("插件没有声明工具。");
        return new Definition(
                id,
                root.path("name").asText(id),
                root.path("version").asText("0.0.0"),
                root.path("description").asText(""),
                directory,
                executable,
                List.copyOf(arguments),
                List.copyOf(tools));
    }

    private static Path resolveExecutable(Path directory, String value) throws IOException {
        Path path = Path.of(value);
        if (path.isAbsolute()) return path.toRealPath();
        if (value.contains("/") || value.contains("\\")) {
            Path relative = directory.resolve(path).normalize().toRealPath();
            if (!relative.startsWith(directory))
                throw new IllegalArgumentException("插件可执行文件超出安装目录。");
            return relative;
        }
        String pathValue = System.getenv("PATH");
        if (pathValue != null) {
            for (String entry : pathValue.split(java.io.File.pathSeparator)) {
                Path candidate = Path.of(entry).resolve(path);
                if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win")
                        && !path.toString().toLowerCase(Locale.ROOT).endsWith(".exe"))
                    candidate = Path.of(entry).resolve(path.toString() + ".exe");
                if (Files.isRegularFile(candidate)) return candidate.toRealPath();
            }
        }
        throw new IllegalArgumentException("找不到插件可执行文件：" + value);
    }

    private List<Stored> load() {
        if (!Files.exists(configFile)) return List.of();
        try {
            return JSON.readValue(configFile.toFile(), new TypeReference<ArrayList<Stored>>() {});
        } catch (Exception error) {
            throw new IllegalStateException("无法读取外部插件配置。", error);
        }
    }

    private void save(List<Stored> plugins) {
        try {
            Files.createDirectories(configFile.getParent());
            Path temporary = Files.createTempFile(configFile.getParent(), "plugins-", ".tmp");
            try {
                JSON.writerWithDefaultPrettyPrinter().writeValue(temporary.toFile(), plugins);
                try {
                    Files.move(
                            temporary,
                            configFile,
                            StandardCopyOption.ATOMIC_MOVE,
                            StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException error) {
                    Files.move(temporary, configFile, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
        } catch (IOException error) {
            throw new IllegalStateException("无法保存外部插件配置。", error);
        }
    }

    private void closeHost(String id) {
        var host = hosts.remove(id);
        if (host != null) host.close();
    }

    @Override
    public void close() {
        synchronized (lock) {
            hosts.values().forEach(PluginProcessHost::close);
            hosts.clear();
        }
    }

    private static String pluginId(Stored stored) {
        try {
            return definitionJson(Path.of(stored.directory())).path("id").asText(
                    stripExtension(Path.of(stored.directory()).getFileName().toString()));
        } catch (Exception ignored) {
            return stripExtension(Path.of(stored.directory()).getFileName().toString());
        }
    }

    private static JsonNode definitionJson(Path directory) throws IOException {
        return JSON.readTree(directory.resolve(MANIFEST).toRealPath().toFile());
    }

    private static String stripExtension(String value) {
        int index = value.lastIndexOf('.');
        return index > 0 ? value.substring(0, index) : value;
    }

    private static String required(JsonNode node, String field) {
        String value = node.path(field).asText().strip();
        if (value.isEmpty()) throw new IllegalArgumentException("缺少字段：" + field);
        return value;
    }

    private static String message(Throwable error) {
        for (Throwable current = error; current != null; current = current.getCause())
            if (current.getMessage() != null && !current.getMessage().isBlank())
                return current.getMessage();
        return error.getClass().getSimpleName();
    }

    private final class ProcessTool extends ToolBase {
        private final String pluginId;
        private final ToolSpec spec;
        private final PluginProcessHost host;

        private ProcessTool(String pluginId, ToolSpec spec, PluginProcessHost host) {
            super(ToolBase.builder()
                    .name(spec.name())
                    .title(spec.name())
                    .description(spec.description())
                    .inputSchema(spec.inputSchema())
                    .readOnly(spec.readOnly())
                    .concurrencySafe(false));
            this.pluginId = pluginId;
            this.spec = spec;
            this.host = host;
        }

        @Override
        public Mono<ToolResultBlock> callAsync(ToolCallParam param) {
            return Mono.fromCallable(() -> {
                try {
                    JsonNode result = host.request("tool_call", Map.of(
                            "pluginId", pluginId,
                            "tool", spec.name(),
                            "input", param.getInput()));
                    if (result != null && result.hasNonNull("error"))
                        return ToolResultBlock.error(result.path("error").asText());
                    String text = result == null
                            ? ""
                            : result.isTextual()
                                    ? result.asText()
                                    : JSON.writerWithDefaultPrettyPrinter()
                                            .writeValueAsString(result);
                    return ToolResultBlock.success(text);
                } catch (Exception error) {
                    return ToolResultBlock.error(message(error));
                }
            });
        }
    }
}
