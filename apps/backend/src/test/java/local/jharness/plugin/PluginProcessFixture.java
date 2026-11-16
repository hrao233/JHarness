package local.jharness.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public final class PluginProcessFixture {
    private static final ObjectMapper JSON = new ObjectMapper();

    private PluginProcessFixture() {}

    public static void main(String[] args) throws Exception {
        var output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        try (var input =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                var request = JSON.readTree(line);
                String id = request.path("id").asText();
                String method = request.path("method").asText();
                if (method.equals("shutdown")) return;
                String text = request.path("params").path("input").path("text").asText();
                output.println(JSON.writeValueAsString(
                        Map.of("id", id, "result", Map.of("echo", text))));
            }
        }
    }
}
