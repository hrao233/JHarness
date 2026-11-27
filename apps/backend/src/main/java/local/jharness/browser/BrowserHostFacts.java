package local.jharness.browser;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;

final class BrowserHostFacts {
    private final Set<String> visited = new LinkedHashSet<>(), blocked = new LinkedHashSet<>();
    private final Set<String> declined;
    private final List<Map<String,String>> artifacts = new ArrayList<>();
    private final Deque<String> console = new ArrayDeque<>(), network = new ArrayDeque<>();
    private int consoleCount, networkCount;
    private String url = "", title = "";

    BrowserHostFacts(Set<String> declined) { this.declined = declined; }

    synchronized void location(String url, String title) {
        this.url = url;
        this.title = title;
        if (!"about:blank".equals(url)) visited.add(BrowserOriginPolicy.origin(url));
    }

    synchronized void block(String url) {
        try { blocked.add(BrowserOriginPolicy.origin(url)); }
        catch (IllegalArgumentException e) { blocked.add(url.split(":", 2)[0] + ":"); }
    }
    synchronized void artifact(Map<String,String> artifact) { artifacts.add(artifact); }

    synchronized void event(String method, JsonNode params) {
        switch (method) {
            case "Runtime.consoleAPICalled" -> {
                if (Set.of("error","warning").contains(params.path("type").asText())) {
                    consoleCount++;
                    add(console, params.path("args").toString());
                }
            }
            case "Runtime.exceptionThrown" -> {
                consoleCount++;
                add(console, params.path("exceptionDetails").toString());
            }
            case "Network.loadingFailed" -> {
                networkCount++;
                add(network, params.path("errorText").asText());
            }
            case "Network.responseReceived" -> {
                var response = params.path("response");
                if (response.path("status").asInt() >= 400) {
                    networkCount++;
                    add(network, response.path("status") + " " + response.path("url").asText());
                }
            }
            default -> {}
        }
    }
    private static void add(Deque<String> items, String value) {
        if (items.size() >= 12) items.removeFirst();
        items.addLast(value.substring(0, Math.min(400, value.length())));
    }
    synchronized Map<String,Object> report() {
        return Map.of("visitedOrigins", List.copyOf(visited), "blockedOrigins", List.copyOf(blocked),
                "declinedOrigins", List.copyOf(declined), "finalUrl", url, "finalTitle", title,
                "consoleErrorCount", consoleCount, "networkErrorCount", networkCount,
                "consoleErrors", List.copyOf(console), "networkErrors", List.copyOf(network),
                "screenshotArtifacts", List.copyOf(artifacts));
    }
}
