package local.jharness.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.tool.ToolCallParam;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ExternalPluginManagerTest {
    @TempDir Path temporary;

    @Test
    void installsEnablesCallsAndPersistsAnExplicitToolPlugin() throws Exception {
        Path plugin = Files.createDirectories(temporary.resolve("echo-plugin"));
        Path java = Path.of(
                System.getProperty("java.home"),
                "bin",
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java");
        var manifest = Map.of(
                "id", "echo.fixture",
                "name", "Echo fixture",
                "version", "1.0.0",
                "apiVersion", 1,
                "description", "Test process plugin",
                "executable", java.toString(),
                "arguments", List.of(
                        "-cp",
                        System.getProperty("java.class.path"),
                        PluginProcessFixture.class.getName()),
                "tools", List.of(Map.of(
                        "name", "plugin_echo",
                        "description", "Echo text",
                        "readOnly", true,
                        "inputSchema", Map.of(
                                "type", "object",
                                "properties", Map.of("text", Map.of("type", "string")),
                                "required", List.of("text")))));
        new ObjectMapper().writeValue(plugin.resolve("jharness-plugin.json").toFile(), manifest);

        Path data = Files.createDirectories(temporary.resolve("data"));
        try (var manager = new ExternalPluginManager(data)) {
            var installed = manager.install(plugin);
            assertEquals("echo.fixture", installed.id());
            assertFalse(installed.enabled());
            var enabled = manager.setEnabled("echo.fixture", true);
            assertTrue(enabled.enabled());

            var tools = manager.tools();
            assertEquals(1, tools.size());
            assertEquals("plugin_echo", tools.get(0).getName());
            var result = tools.get(0)
                    .callAsync(ToolCallParam.builder().input(Map.of("text", "hello")).build())
                    .block();
            assertTrue(result.getOutput().toString().contains("hello"));
        }

        try (var reopened = new ExternalPluginManager(data)) {
            assertTrue(reopened.list().get(0).enabled());
        }
    }
}
