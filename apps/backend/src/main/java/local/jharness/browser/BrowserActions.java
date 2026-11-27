package local.jharness.browser;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

public final class BrowserActions {
    private final BrowserSession s;
    private final BrowserVision images;
    private final BrowserSubagent.Approval approval;
    BrowserActions(BrowserSession s, BrowserVision images, BrowserSubagent.Approval approval) {
        this.s = s;
        this.images = images;
        this.approval = approval;
    }

    private synchronized ToolResultBlock perform(String action, Callable<String> operation) {
        try {
            s.awaitAssistant();
            s.progress("action",action);
            return ToolResultBlock.text(operation.call());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return ToolResultBlock.error(action + "：浏览器操作已取消");
        } catch (Exception error) {
            return ToolResultBlock.error(action + "：" + error.getMessage());
        }
    }

    @Tool(name="browser_navigate",description="打开 HTTP(S) 页面。")
    public ToolResultBlock navigate(@ToolParam(name="url") String url) {
        return perform("browser_navigate", () -> {
            s.navigate(BrowserOriginPolicy.normalizeAddress(url, false)); return s.snapshot().toString();
        });
    }

    @Tool(name="browser_snapshot",description="刷新可见元素编号与页面文字。")
    public ToolResultBlock snapshot() {
        return perform("browser_snapshot", () -> {
            return s.snapshot().toString();
        });
    }

    @Tool(name="browser_click",description="点击快照中的元素。")
    public ToolResultBlock click(@ToolParam(name="ref",required=false) Integer ref, @ToolParam(name="selector",required=false) String selector) {
        return perform("browser_click", () -> {
            long before = s.navigationRevision();
            s.element(ref,selector,"el.click()");
            s.waitAfterAction(before);
            return "已点击";
        });
    }

    @Tool(name="browser_fill",description="填写普通输入框或可编辑区域。")
    public ToolResultBlock fill(@ToolParam(name="ref",required=false) Integer ref, @ToolParam(name="selector",required=false) String selector, @ToolParam(name="value") String value) {
        return perform("browser_fill", () -> {
            s.element(ref,selector,"const text=" + BrowserSession.quote(value) + ";"
                    + """
                      if (el.isContentEditable) el.textContent = text;
                      else if (el.matches('input,textarea')) {
                        const proto = el.matches('input') ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
                      } else throw Error('不可填写');
                      el.dispatchEvent(new InputEvent('input', {bubbles:true, data:text, inputType:'insertText'}));
                      el.dispatchEvent(new Event('change', {bubbles:true}));
                      """);
            return "已填写";
        });
    }

    @Tool(name="browser_select",description="按值选择下拉选项。")
    public ToolResultBlock select(@ToolParam(name="ref",required=false) Integer ref, @ToolParam(name="selector",required=false) String selector, @ToolParam(name="value") String value) {
        return perform("browser_select", () -> {
            String text = BrowserSession.quote(value);
            s.element(ref,selector,"if(!el.matches('select') || !Array.from(el.options).some(o=>o.value===" + text
                    + ")) throw Error('找不到选项');el.value=" + text + ";el.dispatchEvent(new Event('change',{bubbles:true}))");
            return "已选择";
        });
    }

    @Tool(name="browser_scroll",description="按垂直像素滚动页面。")
    public ToolResultBlock scroll(@ToolParam(name="dy") int dy) {
        return perform("browser_scroll", () -> {
            s.evaluate("scrollBy(0," + Math.max(-10000,Math.min(10000,dy)) + ")"); return s.snapshot().toString();
        });
    }

    @Tool(name="browser_press_key",description="向当前页面发送 Enter、Tab、Escape、Backspace、Space 或方向键。")
    public ToolResultBlock pressKey(@ToolParam(name="key") String key,
            @ToolParam(name="ref",required=false) Integer ref,
            @ToolParam(name="selector",required=false) String selector) {
        return perform("browser_press_key", () -> {
            if (ref != null || selector != null) s.element(ref,selector,"el.focus()");
            int code = switch (key) {
                case "Enter" -> 13; case "Tab" -> 9; case "Escape" -> 27;
                case "Backspace" -> 8; case "Space" -> 32;
                case "ArrowDown" -> 40; case "ArrowUp" -> 38; case "ArrowLeft" -> 37; case "ArrowRight" -> 39;
                default -> throw new IllegalArgumentException("不支持此按键");
            };
            s.evaluate("(() => {if(document.activeElement?.matches('input[type=password],[autocomplete=one-time-code],[autocomplete^=cc-]'))throw Error('需要人工接管');return true})()");
            long before = s.navigationRevision();
            for (String type : List.of("keyDown","keyUp")) {
                var params = new java.util.HashMap<String,Object>(Map.of("type",type,"key","Space".equals(key) ? " " : key,
                        "code",key,"windowsVirtualKeyCode",code));
                if (type.equals("keyDown") && (key.equals("Space") || key.equals("Enter")))
                    params.put("text", key.equals("Space") ? " " : "\r");
                s.cdp.send("Input.dispatchKeyEvent",params);
            }
            if (key.equals("Enter")) s.waitAfterAction(before);
            return "已发送按键";
        });
    }

    @Tool(name="browser_wait_for",description="等待选择器对应的元素可见。")
    public ToolResultBlock waitFor(@ToolParam(name="selector") String selector) {
        return perform("browser_wait_for", () -> {
            long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            do {
                if (s.evaluate("(() => {const el=document.querySelector(" + BrowserSession.quote(selector)
                        + ");return !!el && el.checkVisibility() && !!el.getClientRects().length})()").asBoolean())
                    return s.snapshot().toString();
                Thread.sleep(100);
            } while (System.nanoTime() < deadline);
            throw new IllegalStateException("等待元素超时");
        });
    }

    @Tool(name="browser_screenshot",description="截取当前视口并登记 PNG 交付物。")
    public ToolResultBlock screenshot() {
        return perform("browser_screenshot", () -> {
            images.replace(s.screenshot()); return BrowserSession.quote(s.facts.report().get("screenshotArtifacts"));
        });
    }

    @Tool(name="browser_console_errors",description="读取近期控制台错误与网络请求失败摘要。")
    public ToolResultBlock consoleErrors() {
        return perform("browser_console_errors", () -> {
            return BrowserSession.quote(s.facts.report());
        });
    }

    @Tool(name="browser_back",description="返回上一页。")
    public ToolResultBlock back() {
        return perform("browser_back", () -> {
            s.evaluate("location.href"); BrowserSession.history(s.cdp,"back"); return "已发送导航请求";
        });
    }

    @Tool(name="browser_forward",description="前进一页。")
    public ToolResultBlock forward() {
        return perform("browser_forward", () -> {
            s.evaluate("location.href"); BrowserSession.history(s.cdp,"forward"); return "已发送导航请求";
        });
    }

    @Tool(name="browser_reload",description="刷新网页。")
    public ToolResultBlock reload() {
        return perform("browser_reload", () -> {
            s.evaluate("location.href"); s.cdp.send("Page.reload", Map.of()); return "已发送导航请求";
        });
    }

    @Tool(name="browser_request_user_takeover",description="在登录、验证码或支付确认时等待用户操作。")
    public ToolResultBlock requestUserTakeover(@ToolParam(name="reason") String reason) {
        return perform("browser_request_user_takeover", () -> {
            if (s.host.endpoint == null) {
                s.blockTask("需要人工介入，请在桌面内置浏览器中继续：" + reason);
                throw new IllegalStateException(s.blockedReason);
            }
            String url = s.url();
            String origin = BrowserOriginPolicy.origin(url);
            s.requested = true;
            s.manual(true);
            boolean allowed;
            try { allowed = approval.ask(s.run,"browser_takeover",origin,reason + "\n当前页面：" + url); }
            finally { s.requested = false; s.manual(false); }
            if (!allowed) { s.blockTask("用户中止了浏览器任务"); throw new IllegalStateException("用户中止了浏览器任务"); }
            return s.snapshot().toString();
        });
    }
}
