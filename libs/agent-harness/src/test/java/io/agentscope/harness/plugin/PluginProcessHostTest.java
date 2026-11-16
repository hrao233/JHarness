/*
 * Copyright 2024-2026 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package io.agentscope.harness.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PluginProcessHostTest {

    @Test
    void executesExplicitJsonLineProtocolInAnIsolatedProcess() throws Exception {
        Path java = javaExecutable();
        PluginProcessSpec spec =
                new PluginProcessSpec(
                        java,
                        List.of(
                                "-cp",
                                System.getProperty("java.class.path"),
                                PluginProcessFixture.class.getName()),
                        Path.of("").toAbsolutePath(),
                        Map.of("JHARNESS_PLUGIN_FIXTURE", "isolated"),
                        Duration.ofSeconds(5),
                        Duration.ofSeconds(5),
                        Duration.ofSeconds(2));

        try (PluginProcessHost host = PluginProcessHost.start(spec)) {
            var result = host.request("ping", Map.of());

            assertEquals("pong", result.path("value").asText());
            assertEquals("isolated", result.path("fixture").asText());
            assertEquals(host.pid(), result.path("pid").asLong());
            assertTrue(host.isAlive());
        }
    }

    @Test
    void surfacesChildProtocolErrorsWithoutCrashingTheHost() throws Exception {
        PluginProcessSpec spec =
                new PluginProcessSpec(
                        javaExecutable(),
                        List.of(
                                "-cp",
                                System.getProperty("java.class.path"),
                                PluginProcessFixture.class.getName()),
                        Path.of("").toAbsolutePath(),
                        Map.of(),
                        Duration.ofSeconds(5),
                        Duration.ofSeconds(5),
                        Duration.ofSeconds(2));

        try (PluginProcessHost host = PluginProcessHost.start(spec)) {
            var error =
                    assertThrows(
                            PluginProcessException.class,
                            () -> host.request("fail", Map.of()));

            assertTrue(error.getMessage().contains("expected failure"));
            assertTrue(host.isAlive(), host.diagnostics());
        }
    }

    private static Path javaExecutable() {
        String executable = System.getProperty("os.name").toLowerCase().contains("win")
                ? "java.exe"
                : "java";
        return Path.of(System.getProperty("java.home"), "bin", executable);
    }
}
