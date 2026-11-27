package local.jharness.browser;

import io.agentscope.core.agent.*;
import io.agentscope.core.event.AgentEvent;
import io.agentscope.core.message.*;
import io.agentscope.core.middleware.*;
import java.util.*;
import java.util.function.Function;
import reactor.core.publisher.Flux;

/** Screenshots live only in this child model's transient request, never in a tool log. */
final class BrowserVision implements MiddlewareBase {
    private volatile boolean enabled;
    private volatile ImageBlock latest;
    BrowserVision(boolean enabled) { this.enabled = enabled; }
    void replace(String data) {
        if (enabled) latest = ImageBlock.builder().source(Base64Source.builder()
                .mediaType("image/png").data(data).build()).build();
    }
    @Override public Flux<AgentEvent> onModelCall(Agent agent, RuntimeContext ctx, ModelCallInput input,
            Function<ModelCallInput,Flux<AgentEvent>> next) {
        ImageBlock image = latest;
        if (!enabled || image == null) return next.apply(input);
        var messages = new ArrayList<>(input.messages());
        messages.add(Msg.builder().role(MsgRole.USER).content(List.of(
                TextBlock.builder().text("最新浏览器截图；更早的截图已省略。").build(),image)).build());
        return next.apply(new ModelCallInput(messages,input.tools(),input.options(),input.model()))
                .onErrorResume(error -> {
                    if (!unsupported(error)) return Flux.error(error);
                    enabled = false;
                    latest = null;
                    return next.apply(input);
                });
    }
    private static boolean unsupported(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            String message = String.valueOf(cause.getMessage()).toLowerCase(Locale.ROOT);
            if (message.contains("400") || message.contains("multimodal") || message.contains("image input")
                    || message.contains("image_url")) return true;
        }
        return false;
    }
}
