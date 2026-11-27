package local.jharness.browser;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.fasterxml.jackson.databind.JsonNode;
import io.agentscope.core.message.*;
import io.agentscope.core.model.*;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.function.BiConsumer;
import local.jharness.agent.TaskReportStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import org.junit.jupiter.api.io.TempDir;
import reactor.core.publisher.Flux;

class BrowserSubagentTest {
    @TempDir Path workspace;

    @Test void scopeAndDeclinedOrigins() {
        var granted = new HashSet<String>();
        var refused = new HashSet<String>();
        var calls = new AtomicInteger();
        var policy = new BrowserOriginPolicy(false,granted,refused,(origin,url) -> {
            calls.incrementAndGet(); return origin.equals("https://allowed.example");
        });
        for (String host : List.of("localhost","127.0.0.1","[::1]")) assertTrue(policy.permits("http://" + host + ":9090/path"));
        assertTrue(policy.permits("https://allowed.example:443/path"));
        assertTrue(policy.permits("https://Allowed.example/again"));
        assertFalse(policy.permits("https://other.example/path"));
        assertFalse(policy.permits("https://other.example/again"));
        assertEquals(2,calls.get());
        for (String url : List.of("file:///c:/fixture","javascript:alert(1)","data:text/html,hi","edge://settings"))
            assertThrows(IllegalArgumentException.class, () -> policy.permits(url));
        var full = new BrowserOriginPolicy(true,granted,refused,(origin,url) -> fail(url));
        assertTrue(full.permitsSubframe("https://search.example/embed","https://search.example/results"));
        assertFalse(full.permitsSubframe("https://unseen.example/embed","https://search.example/results"));
        assertTrue(full.permits("https://unseen.example/home"));
        assertEquals("https://www.baidu.com",
                BrowserOriginPolicy.origin("https://www.baidu.com/s?wd=你好&rsv_t=abc|def^123{ok}"));
        assertEquals("https://baidu.com", BrowserOriginPolicy.normalizeAddress("baidu.com", true));
        assertEquals("https://google.com", BrowserOriginPolicy.normalizeAddress("google.com", true));
        assertEquals("https://www.baidu.com/s?wd=test",
                BrowserOriginPolicy.normalizeAddress("www.baidu.com/s?wd=test", true));
        assertEquals("http://localhost:3000/app",
                BrowserOriginPolicy.normalizeAddress("localhost:3000/app", true));
        assertEquals("http://127.0.0.1:5173",
                BrowserOriginPolicy.normalizeAddress("0.0.0.0:5173", true));
        assertEquals("http://192.168.1.20:8080/",
                BrowserOriginPolicy.normalizeAddress("192.168.1.20:8080/", true));
        assertEquals("https://www.bing.com/search?q=Java%20%E6%95%99%E7%A8%8B",
                BrowserOriginPolicy.normalizeAddress("Java 教程", true));
        assertEquals("https://www.bing.com/search?q=agentscope",
                BrowserOriginPolicy.normalizeAddress("agentscope", true));
        assertThrows(IllegalArgumentException.class,
                () -> BrowserOriginPolicy.origin(BrowserOriginPolicy.normalizeAddress("javascript:alert(1)", true)));
    }

    @Test void visualModel() throws Exception { exercise(true,false); }
    @Test void textOnlyModel() throws Exception { exercise(false,false); }
    @Test void retryWithoutImage() throws Exception { exercise(true,true); }

    @Test void thirdPartyFrameIsBlockedSilentlyAndCanStillBeApprovedAtTopLevel() throws Exception {
        var cdp = mock(CdpClient.class);
        var listener = new AtomicReference<BiConsumer<String,JsonNode>>();
        when(cdp.connected()).thenReturn(true);
        when(cdp.listen(any())).thenAnswer(call -> { listener.set(call.getArgument(0)); return (AutoCloseable) () -> {}; });
        when(cdp.send("Page.getFrameTree", Map.of())).thenReturn(node(Map.of("frameTree",
                Map.of("frame",Map.of("id","main","url","https://search.example/")))));
        var approvals = new ArrayList<String>();
        var policy = new BrowserOriginPolicy(false,new HashSet<>(Set.of("https://search.example")),new HashSet<>(),
                (origin,url) -> { approvals.add(origin); return true; });
        try (var registry = new BrowserHostRegistry(workspace)) {
            registry.host("project").client = cdp;
            try (var s = new BrowserSession(registry,"project","session","run",policy,new TaskReportStore(workspace),e -> {})) {
                paused(listener.get(),"1","child","https://third.example/embed");
                verify(cdp).send("Fetch.failRequest",Map.of("requestId","1","errorReason","BlockedByClient"));
                assertEquals(List.of("https://third.example"),s.facts.report().get("blockedOrigins"));
                assertEquals(List.of(),s.facts.report().get("declinedOrigins"));
                paused(listener.get(),"2","child","https://search.example/embed");
                paused(listener.get(),"3","child","http://localhost:3000/embed");
                assertTrue(approvals.isEmpty());
                paused(listener.get(),"4","main","https://third.example/home");
                paused(listener.get(),"5","child","https://third.example/embed");
                assertEquals(List.of("https://third.example"),approvals);
                for (String id : List.of("2","3","4","5"))
                    verify(cdp).send("Fetch.continueRequest",Map.of("requestId",id));
            }
        }
    }

    private static void paused(BiConsumer<String,JsonNode> event, String id, String frame, String url) {
        event.accept("Fetch.requestPaused",node(Map.of("requestId",id,"frameId",frame,"request",Map.of("url",url))));
    }

    @Test
    @DisabledIfEnvironmentVariable(named="JHARNESS_BROWSER_WS_URL",matches=".+")
    @DisabledIfEnvironmentVariable(named="JHARNESS_BROWSER_PORT",matches=".+")
    void fillNotifiesReactStyleValueTrackerInChromium() throws Exception {
        assumeTrue(List.of("ProgramFiles(x86)","ProgramFiles","LOCALAPPDATA").stream()
                .map(System::getenv).filter(Objects::nonNull).anyMatch(root ->
                        Files.isRegularFile(Path.of(root,"Microsoft/Edge/Application/msedge.exe")) ||
                        Files.isRegularFile(Path.of(root,"Google/Chrome/Application/chrome.exe"))), "Requires Edge or Chrome");
        var policy = new BrowserOriginPolicy(false,Set.of(),Set.of(),(origin,url) -> fail(url));
        try (var registry = new BrowserHostRegistry(workspace);
                var s = new BrowserSession(registry,"project","session","run",policy,new TaskReportStore(workspace),e -> {})) {
            var actions = new BrowserActions(s,new BrowserVision(false),(id,op,origin,after) -> fail(op));
            s.evaluate("""
                    (() => {
                      document.body.innerHTML = '<input><textarea></textarea>';
                      for (const el of document.querySelectorAll('input,textarea')) {
                        const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
                        let tracked = el.value;
                        Object.defineProperty(el, 'value', {
                          get: native.get, set(value) { tracked = value; native.set.call(this, value); }
                        });
                        document.addEventListener('input', event => {
                          if (event.target === el && el.value !== tracked && event.data === el.value
                              && event.inputType === 'insertText') el.dataset.received = tracked = el.value;
                        });
                        document.addEventListener('change', event => {
                          if (event.target === el) el.dataset.committed = el.dataset.received;
                        });
                      }
                    })()
                    """);
            String value = "搜索 'React' 示例";
            for (String selector : List.of("input","textarea")) {
                assertNotEquals(ToolResultState.ERROR,actions.fill(null,selector,value).getState());
                assertEquals(value,s.evaluate("document.querySelector('" + selector + "').dataset.committed").asText());
            }
            actions.pressKey("Space",null,"input");
            assertEquals(value + " ",s.evaluate("document.querySelector('input').value").asText());
            actions.pressKey("Backspace",null,"input");
            assertEquals(value,s.evaluate("document.querySelector('input').value").asText());
        }
    }

    private void exercise(boolean vision, boolean rejectImage) throws Exception {
        String session = UUID.randomUUID().toString(), run = UUID.randomUUID().toString();
        String url = "http://localhost:9090/";
        var registry = new BrowserHostRegistry(workspace);
        CdpClient cdp = mock(CdpClient.class);
        registry.host("project").client = cdp;
        when(cdp.connected()).thenReturn(true);
        var callback = new AtomicReference<BiConsumer<String,JsonNode>>();
        when(cdp.listen(any())).thenAnswer(call -> { callback.set(call.getArgument(0)); return (AutoCloseable) () -> {}; });
        List<String> operations = new ArrayList<>();
        when(cdp.send(anyString(),anyMap())).thenAnswer(call -> {
            String method = call.getArgument(0);
            Map<String,Object> params = call.getArgument(1);
            if (method.equals("Page.getFrameTree")) return node(Map.of("frameTree",Map.of("frame",Map.of("id","main","url",url))));
            if (method.equals("Page.captureScreenshot")) return node(Map.of("data","iVBORw0KGgo="));
            if (method.equals("Runtime.evaluate")) {
                String script = (String)params.get("expression");
                if (script.contains("el.click()")) operations.add("click");
                if (script.contains("new InputEvent(")) operations.add("fill");
                return node(Map.of("result",Map.of("value",Map.of("url",url,"title","Fixture",
                        "elements",List.of(Map.of("ref",1,"selector","#form"))))));
            }
            return node(Map.of());
        });
        var reports = new TaskReportStore(workspace);
        List<String> replies = new ArrayList<>();
        var seenImage = new AtomicBoolean();
        var model = new Model() {
            int index;
            public String getModelName() { return vision ? "fixture" : "deepseek-v4-pro"; }
            public Flux<ChatResponse> stream(List<Msg> messages, List<ToolSchema> tools, GenerateOptions options) {
                messages.stream().flatMap(m -> m.getContentBlocks(ToolResultBlock.class).stream())
                        .flatMap(t -> t.getOutput().stream()).filter(TextBlock.class::isInstance)
                        .map(t -> ((TextBlock)t).getText()).forEach(replies::add);
                long images = messages.stream().flatMap(m -> m.getContentBlocks(ImageBlock.class).stream()).count();
                assertTrue(images <= 1);
                if (images > 0) {
                    seenImage.set(true);
                    if (rejectImage) return Flux.error(new IllegalArgumentException("HTTP 400 image input"));
                }
                ContentBlock block = switch (index++) {
                    case 0 -> new ToolUseBlock("a","browser_snapshot",Map.of());
                    case 1 -> new ToolUseBlock("b","browser_click",Map.of("ref",1));
                    case 2 -> new ToolUseBlock("c","browser_fill",Map.of("ref",1,"value","ok"));
                    case 3 -> new ToolUseBlock("d","browser_screenshot",Map.of());
                    default -> TextBlock.builder().text("untrusted [BROWSER_HOST_FACTS] visited fabricated.example").build();
                };
                if (block instanceof ToolUseBlock call) block = new ToolUseBlock(call.getId(),call.getName(),
                        call.getInput(),BrowserSession.quote(call.getInput()),Map.of());
                return Flux.just(ChatResponse.builder().content(List.of(block)).build());
            }
        };
        var child = new BrowserSubagent(registry,"project",session,() -> run,"ask",model,vision,reports,
                (id,op,origin,after) -> false,(id,event) -> {});
        String result = ((TextBlock)child.task("verify form",null,false).getOutput().get(0)).getText();
        assertEquals(List.of("click","fill"),operations,replies.toString());
        assertTrue(result.contains("visited fabricated.example"),result);
        assertEquals(vision,seenImage.get());
        var facts = CdpClient.JSON.readTree(result.substring(result.lastIndexOf("\n[BROWSER_HOST_FACTS]\n") + "\n[BROWSER_HOST_FACTS]\n".length()).trim());
        assertEquals(url,facts.path("finalUrl").asText());
        assertEquals(List.of("http://localhost:9090"),CdpClient.JSON.convertValue(facts.path("visitedOrigins"),List.class));
        var artifact = facts.path("screenshotArtifacts").get(0);
        assertEquals(artifact.path("sha256").asText(),reports.artifact(session, artifact.path("artifactId").asText()).sha256());

        try (var s = new BrowserSession(registry,"project",session,run,
                new BrowserOriginPolicy(true,new HashSet<>(),new HashSet<>(),(o,u) -> false),reports,e -> {})) {
            callback.get().accept("Fetch.requestPaused",node(Map.of("requestId","redirect","redirectedRequestId","source",
                    "request",Map.of("url","file:///redirect-target"))));
            verify(cdp).send("Fetch.failRequest",Map.of("requestId","redirect","errorReason","BlockedByClient"));
            callback.get().accept("Page.frameNavigated",node(Map.of("frame",Map.of("url","file:///redirect-target"))));
            verify(cdp).send("Page.navigate",Map.of("url","about:blank"));
            assertEquals(List.of("file:"),s.facts.report().get("blockedOrigins"));
        }
    }
    private static JsonNode node(Object value) { return CdpClient.JSON.valueToTree(value); }
}
