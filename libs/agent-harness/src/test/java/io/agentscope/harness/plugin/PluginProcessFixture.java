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

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Stand-alone child process used by {@link PluginProcessHostTest}. */
public final class PluginProcessFixture {

    private PluginProcessFixture() {}

    public static void main(String[] args) throws Exception {
        ObjectMapper json = new ObjectMapper();
        try (BufferedReader input =
                        new BufferedReader(
                                new InputStreamReader(System.in, StandardCharsets.UTF_8));
                BufferedWriter output =
                        new BufferedWriter(
                                new OutputStreamWriter(System.out, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                JsonNode request = json.readTree(line);
                String id = request.path("id").asText();
                String method = request.path("method").asText();
                if (method.equals("shutdown")) {
                    respond(json, output, Map.of("id", id, "result", Map.of("stopped", true)));
                    return;
                }
                if (method.equals("ping")) {
                    respond(
                            json,
                            output,
                            Map.of(
                                    "id",
                                    id,
                                    "result",
                                    Map.of(
                                            "value",
                                            "pong",
                                            "pid",
                                            ProcessHandle.current().pid(),
                                            "fixture",
                                            System.getenv(
                                                    "JHARNESS_PLUGIN_FIXTURE"))));
                } else if (method.equals("fail")) {
                    respond(json, output, Map.of("id", id, "error", "expected failure"));
                } else {
                    respond(json, output, Map.of("id", id, "error", "unknown method"));
                }
            }
        }
    }

    private static void respond(
            ObjectMapper json, BufferedWriter output, Map<String, Object> response)
            throws Exception {
        output.write(json.writeValueAsString(response));
        output.newLine();
        output.flush();
    }
}
