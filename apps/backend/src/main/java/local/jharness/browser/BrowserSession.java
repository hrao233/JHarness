package local.jharness.browser;

import com.fasterxml.jackson.databind.JsonNode;
import io.agentscope.harness.agent.artifact.ArtifactDeliveryRequest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.function.Consumer;
import local.jharness.agent.TaskReportStore;

final class BrowserSession implements AutoCloseable {
    final BrowserHostRegistry.Host host;
    final BrowserHostFacts facts;
    final String run;
    final CdpClient cdp;
    final BrowserOriginPolicy policy;
    private final Consumer<Map<String,Object>> events;
    private final String session;
    private final TaskReportStore reports;
    private final Map<Integer,String> refs = new HashMap<>();
    private final AutoCloseable subscription;
    volatile String blockedReason;
    private String snapshotUrl = "";
    private volatile boolean cancelled, closed;
    private volatile JsonNode mainFrame;
    private volatile long navigationRevision;
    private volatile boolean awaitingCommit;
    volatile boolean manual, requested;
    volatile Runnable interrupt = () -> {};
    private int step;

    BrowserSession(BrowserHostRegistry registry, String project, String session, String run,
            BrowserOriginPolicy policy, TaskReportStore reports, Consumer<Map<String,Object>> events) throws Exception {
        this.host = registry.host(project);
        this.run = Objects.requireNonNull(run);
        this.session = session;
        this.reports = reports;
        this.events = events;
        this.policy = policy;
        facts = new BrowserHostFacts(registry.refusals(run));
        synchronized (host) {
            if (host.active != null) throw new IllegalStateException("此项目的浏览器正由另一项任务使用");
            cdp = host.connect();
            host.active = this;
        }
        subscription = cdp.listen(this::event);
        try {
            mainFrame = frame();
            cdp.send("Fetch.enable", Map.of("patterns", List.of(Map.of("resourceType","Document","requestStage","Request"))));
            progress("start", "browser_task");
        } catch (RuntimeException error) { close(); throw error; }
    }

    void blockTask(String reason) {
        blockedReason = reason;
        progress("blocked",reason);
        cancel();
    }
    void cancel() {
        cancelled = true;
        cdp.cancelPending();
        synchronized (this) { notifyAll(); }
        interrupt.run();
    }
    synchronized void manual(boolean value) {
        if (requested && !value) throw new IllegalStateException("请通过审批卡继续任务");
        manual = value;
        notifyAll();
        progress("control", value ? "人工接管" : "助手操作");
    }
    boolean running() { return !cancelled && !closed; }
    void check() {
        if (cancelled || closed || Thread.currentThread().isInterrupted()) throw new CancellationException("浏览器任务已取消");
    }
    synchronized void awaitAssistant() {
        check();
        while (manual) {
            try { wait(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            check();
        }
    }
    synchronized void progress(String phase, String action) {
        var report = facts.report();
        if (phase.equals("action")) step++;
        events.accept(Map.of("projectId",host.project,"phase",phase,"action",action,"step",step,
                "url",report.get("finalUrl"),"title",report.get("finalTitle"),"takeover",manual,
                "screenshotArtifacts",report.get("screenshotArtifacts")));
    }
    private boolean permitted(String url, boolean subframe) {
        try {
            check();
            if (subframe ? policy.permitsSubframe(url,mainFrame.path("url").asText()) : policy.permits(url)) {
                check();
                return true;
            }
        } catch (IllegalArgumentException ignored) {}
        facts.block(url);
        return false;
    }
    private void require(String url) {
        if (!permitted(url,false)) throw new IllegalArgumentException("已阻止浏览器访问 " + url);
    }
    private void event(String method, JsonNode params) {
        if (closed) return;
        facts.event(method, params);
        var main = mainFrame;
        String frameId = params.path("frameId").asText("");
        boolean subframe = main != null && !frameId.isEmpty() && !frameId.equals(main.path("id").asText());
        if ("Fetch.requestPaused".equals(method)) {
            String id = params.path("requestId").asText();
            String url = params.path("request").path("url").asText();
            boolean allowed = false;
            try { allowed = permitted(url,subframe); }
            finally {
                if (!closed) cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
                        allowed ? Map.of("requestId",id) : Map.of("requestId",id,"errorReason","BlockedByClient"));
            }
        } else if ("Page.frameNavigated".equals(method) && !params.path("frame").has("parentId")) {
            var frame = params.path("frame");
            if (frame.hasNonNull("id")) mainFrame = frame;
            awaitingCommit = false;
            navigationRevision++;
            String url = frame.path("url").asText();
            if ("about:blank".equals(url)) facts.location(url,"");
            else if (!permitted(url,false)) cdp.send("Page.navigate", Map.of("url","about:blank"));
            else if (!frame.hasNonNull("unreachableUrl")) facts.location(url,"");
        } else if (!subframe && !frameId.isEmpty()) {
            switch (method) {
                case "Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.navigatedWithinDocument" -> {
                    awaitingCommit = method.equals("Page.frameStartedLoading");
                    navigationRevision++;
                }
            }
        }
    }
    String url() { return frame().path("url").asText(); }
    private JsonNode frame() {
        return cdp.send("Page.getFrameTree", Map.of()).path("frameTree").path("frame");
    }
    JsonNode evaluate(String expression) {
        awaitAssistant();
        var frame = frame();
        String url = frame.path("url").asText();
        if (frame.hasNonNull("unreachableUrl")) throw new IllegalStateException("页面未成功加载");
        if (!"about:blank".equals(url)) require(url);
        int context = cdp.send("Page.createIsolatedWorld", Map.of("frameId",frame.path("id").asText(),
                "worldName","jharness.browser")).path("executionContextId").asInt();
        var result = cdp.send("Runtime.evaluate", Map.of("contextId",context,"returnByValue",true,
                "expression","(() => { if (location.href !== " + quote(url) + ") throw Error('页面已更改'); return " + expression + "; })()"));
        if (result.has("exceptionDetails")) throw new IllegalStateException("页面操作失败：" + result.path("exceptionDetails").path("exception").path("description").asText());
        return result.path("result").path("value");
    }
    JsonNode snapshot() {
        var data = evaluate(DomSnapshotter.SNAPSHOT);
        snapshotUrl = data.path("url").asText();
        facts.location(snapshotUrl,data.path("title").asText());
        refs.clear();
        for (var el : data.path("elements")) refs.put(el.path("ref").asInt(),el.path("selector").asText());
        return data;
    }
    static String quote(Object value) { return CdpClient.JSON.valueToTree(value).toString(); }
    JsonNode element(Integer ref, String selector, String body) {
        if (ref != null && (!refs.containsKey(ref) || !snapshotUrl.equals(url())))
            throw new IllegalArgumentException("元素编号已失效，请刷新快照");
        String target = ref == null ? selector : refs.get(ref);
        if (target == null || target.isBlank()) throw new IllegalArgumentException("请提供元素编号或选择器");
        String match = ref == null ? "" : " || globalThis.__jhHandles?.[" + (ref-1) + "] !== el";
        return evaluate("(() => {const el=document.querySelector(" + quote(target)
                + ");if(!el" + match + ") throw Error('元素已更改，请刷新快照');"
                + "if(el.matches('input[type=password],input[type=file],[autocomplete=one-time-code],[autocomplete^=cc-]')) throw Error('需要人工接管');"
                + body + ";return true})()");
    }
    void navigate(String url) throws InterruptedException {
        awaitAssistant();
        require(url);
        var nav = cdp.send("Page.navigate", Map.of("url",url), Duration.ofMinutes(11));
        if (nav.has("errorText")) throw new IllegalStateException(nav.path("errorText").asText());
        waitForDocument(System.nanoTime() + Duration.ofMillis(2500).toNanos());
    }
    long navigationRevision() { return navigationRevision; }

    void waitAfterAction(long before) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofMillis(2500).toNanos();
        // Chromium may emit the first navigation event just after acknowledging the input.
        if (before == navigationRevision) Thread.sleep(100);
        check();
        if (before != navigationRevision || awaitingCommit) waitForDocument(deadline);
    }

    private void waitForDocument(long deadline) throws InterruptedException {
        while (System.nanoTime() < deadline) {
            check();
            long revision = navigationRevision;
            if (!awaitingCommit) {
                try {
                    var world = cdp.send("Page.createIsolatedWorld", Map.of("frameId",mainFrame.path("id").asText(),
                            "worldName","jharness.browser"), remaining(deadline));
                    var ready = cdp.send("Runtime.evaluate", Map.of("contextId",world.path("executionContextId").asInt(),
                            "returnByValue",true,"expression","document.readyState !== 'loading'"), remaining(deadline));
                    if (ready.path("result").path("value").asBoolean()) {
                        Thread.sleep(Math.min(150,remaining(deadline).toMillis()));
                        check();
                        if (revision == navigationRevision) return;
                    }
                } catch (IllegalStateException transientNavigation) {
                    check();
                    if (!cdp.connected()) throw transientNavigation;
                    // A redirect can destroy the execution context between the two commands.
                }
            }
            Thread.sleep(Math.min(50,remaining(deadline).toMillis()));
        }
        check();
    }

    private static Duration remaining(long deadline) {
        return Duration.ofNanos(Math.max(0,deadline - System.nanoTime()));
    }
    static void history(CdpClient cdp, String direction) {
        var nav = cdp.send("Page.getNavigationHistory", Map.of());
        int index = nav.path("currentIndex").asInt() + ("back".equals(direction) ? -1 : 1);
        var entry = nav.path("entries").path(index);
        if (entry.isMissingNode()) throw new IllegalArgumentException("没有可用的历史页面");
        BrowserOriginPolicy.origin(entry.path("url").asText());
        cdp.send("Page.navigateToHistoryEntry", Map.of("entryId",entry.path("id").asInt()));
    }
    String screenshot() {
        var document = evaluate("({url:location.href,title:document.title})");
        String capturedUrl = document.path("url").asText();
        facts.location(capturedUrl, document.path("title").asText());
        String data = cdp.send("Page.captureScreenshot", Map.of("format","png","fromSurface",true)).path("data").asText();
        if (!capturedUrl.equals(url())) throw new IllegalStateException("截图期间页面已更改");
        byte[] png = Base64.getDecoder().decode(data);
        if (png.length < 8 || java.nio.ByteBuffer.wrap(png).getLong() != 0x89504e470d0a1a0aL)
            throw new IllegalStateException("浏览器未返回 PNG 截图");
        String name = "browser-" + UUID.randomUUID() + ".png";
        var item = reports.saveArtifact(session,run,new ArtifactDeliveryRequest(name,png,name,"浏览器截图",false));
        facts.artifact(Map.of("artifactId",item.id(),"fileName",item.fileName(),"sha256",item.sha256()));
        progress("artifact","browser_screenshot");
        return data;
    }
    @Override public void close() {
        synchronized (host) {
            closed = true;
            boolean interrupted = Thread.interrupted();
            try {
                if (cancelled) cdp.send("Page.stopLoading", Map.of());
            } catch (RuntimeException ignored) {}
            try { cdp.send("Fetch.disable", Map.of()); } catch (RuntimeException ignored) {}
            try { subscription.close(); } catch (Exception ignored) {}
            host.last = facts.report();
            host.active = null;
            if (interrupted) Thread.currentThread().interrupt();
        }
        manual = false;
        progress("done","browser_task");
    }
}
