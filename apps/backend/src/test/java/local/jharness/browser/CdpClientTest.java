package local.jharness.browser;

import static org.junit.jupiter.api.Assertions.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class CdpClientTest {
    @Test void readsContinuationFramesMatchesIdsCollectsEventsAndTimesOut() throws Exception {
        try (var server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            String image = "A".repeat(75000);
            var peer = CompletableFuture.runAsync(() -> {
                try (var socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    var in = new DataInputStream(socket.getInputStream());
                    var out = new DataOutputStream(socket.getOutputStream());
                    StringBuilder headers = new StringBuilder();
                    while (!headers.toString().endsWith("\r\n\r\n")) headers.append((char)in.readUnsignedByte());
                    String key = headers.toString().lines().filter(l -> l.toLowerCase().startsWith("sec-websocket-key:"))
                            .findFirst().orElseThrow().split(":",2)[1].trim();
                    byte[] digest = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                            .getBytes(StandardCharsets.US_ASCII));
                    out.writeBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                            + Base64.getEncoder().encodeToString(digest) + "\r\n\r\n");
                    in.readUnsignedByte();
                    int length = in.readUnsignedByte() & 127;
                    byte[] mask = in.readNBytes(4), payload = in.readNBytes(length);
                    for (int i=0;i<length;i++) payload[i] ^= mask[i%4];
                    var request = CdpClient.JSON.readTree(payload);
                    assertEquals("Page.captureScreenshot",request.path("method").asText());
                    String response = "{\"id\":" + request.path("id") + ",\"result\":{\"data\":\"" + image + "\"}}";
                    frame(out,1,response.substring(0,30000));
                    frame(out,0,response.substring(30000,60000));
                    frame(out,128,response.substring(60000));
                    frame(out,129,"{\"method\":\"Runtime.consoleAPICalled\",\"params\":{\"type\":\"warning\",\"args\":[\"fixture\"]}}");
                    frame(out,129,"{\"method\":\"Network.loadingFailed\",\"params\":{\"errorText\":\"offline\"}}");
                    while (in.read() != -1) { /* Leave the next command unanswered. */ }
                } catch (Exception e) { throw new CompletionException(e); }
            });
            try (var client = new CdpClient(URI.create("ws://127.0.0.1:" + server.getLocalPort() + "/page"))) {
                var facts = new BrowserHostFacts(Set.of());
                var events = new CountDownLatch(2);
                client.listen((method, params) -> { facts.event(method,params); events.countDown(); });
                assertEquals(image,client.send("Page.captureScreenshot",Map.of()).path("data").asText());
                assertTrue(events.await(3,TimeUnit.SECONDS));
                assertEquals(1,facts.report().get("consoleErrorCount"));
                assertEquals(1,facts.report().get("networkErrorCount"));
                assertInstanceOf(TimeoutException.class,assertThrows(IllegalStateException.class,
                        () -> client.send("Page.reload",Map.of(),Duration.ofMillis(100))).getCause());
            }
            peer.get(5,TimeUnit.SECONDS);
        }
    }
    private static void frame(DataOutputStream out,int opcode,String message) throws IOException {
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        out.writeByte(opcode);
        if (bytes.length < 126) out.writeByte(bytes.length);
        else { out.writeByte(126); out.writeShort(bytes.length); }
        out.write(bytes);
        out.flush();
    }
}
