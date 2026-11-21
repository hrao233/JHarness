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
            List<ToolSpec> tools, String digest) {}

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
            List<ToolSpec> tools, String digest) {}

    private record Stored(String directory, boolean enabled, String id, String digest) {
        Stored enabled(boolean value) { return new Stored(directory, value, id, digest); }
    }
    public record Upgrade(String id, String fromDigest, String toDigest, String version, List<String> changes, List<String> excerpts) {}

    private final Path configFile;
    private final PluginSnapshots snapshots;
    private final Map<String, PluginProcessHost> hosts = new LinkedHashMap<>();
    private final Map<String, String> runningVersions = new LinkedHashMap<>();
    private final Map<String, String> errors = new LinkedHashMap<>();
    private static final Map<Path, Object> LOCKS = new java.util.concurrent.ConcurrentHashMap<>();
    private final Object lock;

    public ExternalPluginManager(Path dataDirectory) {
        configFile = dataDirectory.toAbsolutePath().normalize().resolve("external-plugins.json");
        snapshots = new PluginSnapshots(configFile.getParent());
        lock = LOCKS.computeIfAbsent(configFile, ignored -> new Object());
    }

    private <T> T update(java.util.concurrent.Callable<T> action) {
        synchronized (lock) {
            try {
                Files.createDirectories(configFile.getParent());
                try (var channel = java.nio.channels.FileChannel.open(configFile.resolveSibling(".external-plugins.lock"),
                        java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE);
                        var writer = channel.lock()) {
                    return action.call();
                }
            } catch (RuntimeException e) { throw e; }
            catch (Exception e) { throw new IllegalArgumentException(message(e), e); }
        }
    }

    // Pin legacy registrations once, retaining the user's previous enablement choice.
    private List<Stored> registrations() {
        var records = load();
        if (records.stream().noneMatch(s -> s.digest() == null)) return records;
        return update(() -> {
            var updated = new ArrayList<>(load());
            boolean changed = false;
            for (int i = 0; i < updated.size(); i++) {
                var old = updated.get(i);
                if (old.digest() != null) continue;
                try {
                    var approved = preview(Path.of(old.directory()));
                    updated.set(i, pinned(approved, old.enabled()));
                    changed = true;
                } catch (Exception e) { errors.put(pluginId(old), message(e)); }
            }
            if (changed) save(updated);
            return updated;
        });
    }

    public List<Status> list() {
        synchronized (lock) { return registrations().stream().map(this::status).toList(); }
    }

    private Status status(Stored stored) {
        String id = pluginId(stored);
        try {
            var definition = installed(stored);
            var host = hosts.get(id);
            return new Status(id, definition.name(), definition.version(), definition.description(), stored.directory(),
                    stored.enabled(), host != null && host.isAlive(), errors.get(id),
                    host == null ? "" : host.diagnostics(), definition.tools(), stored.digest());
        } catch (Exception e) {
            return new Status(id, id, "", "", stored.directory(), stored.enabled(), false,
                    message(e), "", List.of(), stored.digest());
        }
    }

    public Definition preview(Path directory) throws IOException {
        return definition(directory, snapshots.inspect(directory).digest());
    }

    private Stored pinned(Definition approved, boolean enabled) throws IOException {
        Path copy = snapshots.pin(approved.directory(), approved.digest());
        var frozen = definition(copy, approved.digest(), approved.directory(), approved.directory());
        if (!approved.equals(frozen)) throw new IllegalArgumentException("插件标识已变化。");
        return new Stored(approved.directory().toString(), enabled, approved.id(), approved.digest());
    }

    public void installEnabled(Definition approved) throws IOException {
        update(() -> {
            var plugins = new ArrayList<>(load());
            if (plugins.stream().anyMatch(item -> pluginId(item).equals(approved.id())
                    || item.directory().equals(approved.directory().toString())))
                throw new IllegalArgumentException("此插件已登记，请在插件面板中管理。");
            plugins.add(pinned(approved, true));
            save(plugins);
            return null;
        });
    }

    public Status install(Path directory) {
        return update(() -> {
            var approved = preview(directory);
            var plugins = new ArrayList<>(load());
            if (plugins.stream().anyMatch(item -> pluginId(item).equals(approved.id())))
                throw new IllegalArgumentException("此插件已登记，请使用检查更新。");
            var record = pinned(approved, false);
            plugins.add(record);
            save(plugins);
            return status(record);
        });
    }

    private Stored find(List<Stored> records, String id) {
        return records.stream().filter(item -> pluginId(item).equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("找不到插件。"));
    }

    public Status setEnabled(String id, boolean enabled) {
        registrations();
        return update(() -> {
            var records = new ArrayList<>(load());
            var old = find(records, id);
            if (enabled) installed(old);
            var next = old.enabled(enabled);
            records.set(records.indexOf(old), next);
            save(records);
            if (!enabled) closeHost(id);
            return status(next);
        });
    }

    public Upgrade previewUpgrade(String id) throws IOException {
        var old = find(registrations(), id);
        var current = snapshots.inspect(snapshots.directory(old.digest())).files();
        Path source = Path.of(old.directory());
        var candidate = snapshots.inspect(source);
        var proposed = definition(source, candidate.digest());
        if (!proposed.id().equals(id)) throw new IllegalArgumentException("源目录的插件 id 已变化。");
        var changes = new ArrayList<String>();
        var excerpts = new ArrayList<String>();
        var paths = new java.util.TreeSet<>(current.keySet());
        paths.addAll(candidate.files().keySet());
        for (String path : paths) {
            if (!candidate.files().containsKey(path)) changes.add("删除 " + path);
            else if (!current.containsKey(path)) changes.add("新增 " + path);
            else if (!current.get(path).equals(candidate.files().get(path))) {
                changes.add("修改 " + path);
                if (excerpts.size() < 5) {
                    String excerpt = firstDifference(snapshots.directory(old.digest()).resolve(path), source.resolve(path));
                    if (excerpt != null) excerpts.add(path + " " + excerpt);
                }
            }
        }
        return new Upgrade(id, old.digest(), candidate.digest(), proposed.version(), changes, excerpts);
    }

    private static String firstDifference(Path old, Path proposed) {
        try {
            if (Files.size(old) > 65536 || Files.size(proposed) > 65536) return null;
            String a = Files.readString(old), b = Files.readString(proposed);
            if (a.indexOf(0) >= 0 || b.indexOf(0) >= 0) return null;
            var left = a.lines().iterator();
            var right = b.lines().iterator();
            for (int line = 1; left.hasNext() || right.hasNext(); line++) {
                String from = left.hasNext() ? left.next() : null;
                String to = right.hasNext() ? right.next() : null;
                if (!Objects.equals(from, to)) return "第 " + line + " 行"
                        + (from == null ? "" : "\n− " + from.substring(0, Math.min(160, from.length())))
                        + (to == null ? "" : "\n+ " + to.substring(0, Math.min(160, to.length())));
            }
        } catch (IOException ignored) { }
        return null;
    }

    public Status upgrade(String id, String from, String to) {
        return update(() -> {
            var records = new ArrayList<>(load());
            var old = find(records, id);
            var proposed = preview(Path.of(old.directory()));
            if (!id.equals(proposed.id()) || !Objects.equals(from, old.digest()) || !to.equals(proposed.digest()))
                throw new IllegalArgumentException("插件已变化，请重新检查更新。");
            var next = pinned(proposed, old.enabled());
            records.set(records.indexOf(old), next);
            save(records);
            closeHost(id);
            errors.remove(id);
            return status(next);
        });
    }

    public boolean uninstall(String id) {
        return update(() -> {
            var records = new ArrayList<>(load());
            if (!records.removeIf(record -> pluginId(record).equals(id))) return false;
            save(records);
            closeHost(id);
            errors.remove(id);
            return true;
        });
    }

    public List<AgentTool> tools() { return tools(java.util.Set.of(), java.util.Set.of()); }

    public List<AgentTool> tools(java.util.Set<String> excluded, java.util.Set<String> reservedNames) {
        synchronized (lock) {
            var result = new ArrayList<AgentTool>();
            var names = new LinkedHashSet<String>(reservedNames);
            for (var stored : registrations()) {
                if (!stored.enabled() || excluded.contains(pluginId(stored))) continue;
                try {
                    var definition = installed(stored);
                    for (var tool : definition.tools())
                        if (names.contains(tool.name()))
                            throw new IllegalArgumentException("工具名称重复：" + tool.name());
                    var host = start(definition);
                    definition.tools().forEach(tool -> names.add(tool.name()));
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

    private PluginProcessHost start(Definition definition) throws IOException {
        var existing = hosts.get(definition.id());
        if (existing != null && existing.isAlive() && definition.digest().equals(runningVersions.get(definition.id()))) return existing;
        if (!snapshots.inspect(definition.directory()).digest().equals(definition.digest()))
            throw new IOException("已保存的插件文件发生变化。");
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
        runningVersions.put(definition.id(), definition.digest());
        return host;
    }

    private Definition installed(Stored stored) throws IOException {
        Path copy = snapshots.directory(stored.digest()).toRealPath();
        return definition(copy, stored.digest(), Path.of(stored.directory()), copy);
    }

    private Definition definition(Path folder, String digest) throws IOException {
        Path real = folder.toRealPath();
        return definition(real, digest, real, real);
    }

    private Definition definition(Path folder, String digest, Path source, Path directory) throws IOException {
        folder = folder.toRealPath();
        Path manifest = folder.resolve(MANIFEST).toRealPath();
        if (!manifest.startsWith(folder))
            throw new IllegalArgumentException("插件清单超出安装目录。");
        JsonNode root = JSON.readTree(manifest.toFile());
        String id = required(root, "id");
        if (!id.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"))
            throw new IllegalArgumentException("插件 id 无效。");
        int apiVersion = root.path("apiVersion").asInt(1);
        if (apiVersion != 1) throw new IllegalArgumentException("不支持的插件 API 版本。");
        Path executable = resolveExecutable(directory, rebase(source, directory, required(root, "executable")));
        var arguments = new ArrayList<String>();
        for (var argument : root.path("arguments"))
            arguments.add(rebase(source, directory, argument.asText()));
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
                List.copyOf(tools), digest);
    }

    private static String rebase(Path source, Path copy, String value) {
        try {
            var path = Path.of(value);
            if (!path.isAbsolute()) return value;
            path = path.normalize();
            if (!path.startsWith(source)) {
                // Expand Windows short names even when the original plugin has since been removed.
                Path ancestor = path;
                while (ancestor != null && !Files.exists(ancestor)) ancestor = ancestor.getParent();
                if (ancestor != null) path = ancestor.toRealPath().resolve(ancestor.relativize(path));
            }
            if (path.startsWith(source)) return copy.resolve(source.relativize(path)).toString();
        } catch (java.nio.file.InvalidPathException | IOException ignored) {
            // Arguments such as classpaths can contain multiple paths and separators.
        }
        return value;
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
        if (stored.id() != null) return stored.id();
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
