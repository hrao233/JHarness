package local.jharness.browser;

import java.net.URI;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** A single exclusive browser operator per project. Origins are granted per conversation. */
public final class BrowserHostRegistry implements AutoCloseable {
    final class Host implements AutoCloseable {
        final String project;
        URI endpoint;
        CdpClient client;
        SystemChromiumLauncher launcher;
        volatile BrowserSession active;
        volatile BrowserHostFacts diagnostics = new BrowserHostFacts(Set.of());
        Map<String,Object> last = Map.of();
        Host(String project) { this.project = project; }

        synchronized CdpClient connect() throws Exception {
            if (client != null && client.connected()) return client;
            if (client != null) close();
            try {
                if (endpoint == null) launcher = new SystemChromiumLauncher();
                client = new CdpClient(endpoint != null ? endpoint :
                        launcher.launch(directory.resolve("browser-profiles").resolve(project)));
                diagnostics = new BrowserHostFacts(Set.of());
                CdpClient page = client;
                page.listen((method, params) -> {
                    if ("Page.frameNavigated".equals(method) && !params.path("frame").has("parentId")) {
                        String url = params.path("frame").path("url").asText();
                        var document = new BrowserHostFacts(Set.of());
                        diagnostics = document;
                        try { document.location(url,""); }
                        catch (IllegalArgumentException blocked) {
                            document.block(url);
                            if (active == null) page.send("Page.navigate", Map.of("url","about:blank"));
                        }
                    } else diagnostics.event(method, params);
                });
                for (String domain : List.of("Page","Runtime","Network")) page.send(domain + ".enable", Map.of());
                return client;
            } catch (Exception error) {
                close();
                throw error;
            }
        }

        @Override public synchronized void close() {
            if (active != null) active.cancel();
            if (client != null) client.close();
            if (launcher != null) launcher.close();
            client = null;
            launcher = null;
        }
    }
    private final Path directory;
    private final Map<String,Host> hosts = new ConcurrentHashMap<>();
    private final Map<String,Set<String>> grants = new ConcurrentHashMap<>(), refusals = new ConcurrentHashMap<>();
    public BrowserHostRegistry(Path directory) { this.directory = directory; }
    Host host(String project) { return hosts.computeIfAbsent(project, Host::new); }

    public void configure(String project, String url) {
        Host h = host(project);
        URI endpoint = SystemChromiumLauncher.localSocket(url);
        synchronized (h) {
            if (!endpoint.equals(h.endpoint)) {
                h.close();
                h.endpoint = endpoint;
            }
        }
    }

    Set<String> grants(String project, String session) {
        return grants.computeIfAbsent(project + "/" + session, ignored -> ConcurrentHashMap.newKeySet());
    }
    Set<String> refusals(String run) {
        return refusals.computeIfAbsent(run, ignored -> ConcurrentHashMap.newKeySet());
    }
    public boolean operating(String run) {
        for (Host host : hosts.values()) {
            synchronized (host) {
                if (host.active != null && host.active.run.equals(run) && host.active.running()) return true;
            }
        }
        return false;
    }
    public void stop(String run) {
        for (Host h : hosts.values()) {
            BrowserSession s;
            synchronized (h) { s = h.active; }
            if (s != null && run.equals(s.run)) s.cancel();
        }
    }
    public void finished(String run) { refusals.remove(run); }

    public Map<String,Object> state(String project) {
        Host h = host(project);
        synchronized (h) {
            var state = new LinkedHashMap<>(h.active == null ? h.last : h.active.facts.report());
            var errors = h.diagnostics.report();
            for (String key : List.of("consoleErrorCount","networkErrorCount","consoleErrors","networkErrors"))
                state.put(key,errors.get(key));
            state.put("active", h.active != null);
            state.put("takeover", h.active != null && h.active.manual);
            return state;
        }
    }

    public Object control(String project, String action, String url) throws Exception {
        Host h = host(project);
        synchronized (h) {
            if (h.active != null) {
                if ("takeover".equals(action) || "release".equals(action)) {
                    h.active.manual("takeover".equals(action));
                    return true;
                }
                throw new IllegalStateException("助手正在操作浏览器");
            }
            CdpClient cdp = h.connect();
            switch (action) {
                case "navigate" -> {
                    String target = BrowserOriginPolicy.normalizeAddress(url, true);
                    BrowserOriginPolicy.origin(target);
                    cdp.send("Page.navigate", Map.of("url", target));
                }
                case "back","forward" -> BrowserSession.history(cdp, action);
                case "reload" -> cdp.send("Page.reload", Map.of());
                case "takeover","release" -> { }
                default -> throw new IllegalArgumentException("未知浏览器操作");
            }
            return true;
        }
    }
    @Override public void close() { hosts.values().forEach(Host::close); }
}
