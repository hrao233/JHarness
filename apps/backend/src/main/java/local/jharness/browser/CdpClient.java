package local.jharness.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BiConsumer;

/** One page target. Event callbacks run off the WebSocket receive thread, in wire order. */
public final class CdpClient implements WebSocket.Listener, AutoCloseable {
    static final ObjectMapper JSON = new ObjectMapper();
    static final Duration TIMEOUT = Duration.ofSeconds(10);
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
    private final AtomicLong sequence = new AtomicLong();
    private final Map<Long, CompletableFuture<JsonNode>> pending = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<BiConsumer<String, JsonNode>> listeners = new CopyOnWriteArrayList<>();
    private final ExecutorService events = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "browser-events");
        t.setDaemon(true);
        return t;
    });
    private final StringBuilder fragments = new StringBuilder();
    private final WebSocket socket;
    private final ReentrantLock writer = new ReentrantLock();
    private volatile boolean closed;

    public CdpClient(URI endpoint) {
        socket = HTTP.newWebSocketBuilder().connectTimeout(TIMEOUT).buildAsync(endpoint, this).join();
    }

    public AutoCloseable listen(BiConsumer<String, JsonNode> listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    public JsonNode send(String method, Map<String, ?> params, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        long id = sequence.incrementAndGet();
        var response = new CompletableFuture<JsonNode>();
        pending.put(id, response);
        try {
            if (closed) throw new IllegalStateException("浏览器连接已关闭");
            String frame = JSON.writeValueAsString(Map.of("id", id, "method", method, "params", params));
            if (!writer.tryLock(deadline - System.nanoTime(),TimeUnit.NANOSECONDS)) throw new TimeoutException(method);
            try {
                socket.sendText(frame, true).get(deadline - System.nanoTime(),TimeUnit.NANOSECONDS);
            } finally { writer.unlock(); }
            return response.get(deadline - System.nanoTime(),TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CancellationException("浏览器操作已取消");
        } catch (Exception e) {
            throw new IllegalStateException(method + " 失败 (" + (e.getCause() == null ? e : e.getCause()) + ")", e);
        } finally {
            pending.remove(id);
        }
    }

    JsonNode send(String method, Map<String, ?> params) { return send(method, params, TIMEOUT); }

    @Override public CompletionStage<?> onText(WebSocket ws, CharSequence text, boolean last) {
        try {
            fragments.append(text);
            if (fragments.length() > 48 * 1024 * 1024) throw new IllegalArgumentException("CDP 消息过大");
            if (last) {
                JsonNode frame = JSON.readTree(fragments.toString());
                fragments.setLength(0);
                if (frame.has("id")) {
                    var future = pending.get(frame.path("id").asLong());
                    if (future != null) {
                        if (frame.has("error")) future.completeExceptionally(new IllegalStateException(frame.path("error").path("message").asText()));
                        else future.complete(frame.path("result"));
                    }
                } else if (frame.has("method")) {
                    var targets = java.util.List.copyOf(listeners);
                    if (!targets.isEmpty()) events.execute(() -> targets.forEach(listener ->
                            listener.accept(frame.path("method").asText(), frame.path("params"))));
                }
            }
            ws.request(1);
        } catch (Exception e) {
            failed(e);
            ws.abort();
        }
        return null;
    }

    @Override public void onError(WebSocket ws, Throwable e) { failed(e); }
    @Override public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
        failed(new IllegalStateException("浏览器连接已断开"));
        return null;
    }
    private void failed(Throwable error) {
        closed = true;
        pending.values().forEach(future -> future.completeExceptionally(error));
        events.shutdownNow();
    }
    void cancelPending() {
        pending.values().forEach(future -> future.completeExceptionally(new CancellationException("浏览器操作已取消")));
    }
    boolean connected() { return !closed; }
    @Override public void close() {
        failed(new IllegalStateException("浏览器连接已关闭"));
        socket.abort();
    }
}
