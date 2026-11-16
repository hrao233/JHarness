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
package local.jharness.plugin;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import io.agentscope.harness.plugin.AgentPlugin;
import io.agentscope.harness.plugin.PluginCapability;
import io.agentscope.harness.plugin.PluginContext;
import io.agentscope.harness.plugin.PluginManifest;
import io.agentscope.harness.plugin.PluginRegistry;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class PluginConsumerTest {

    @Test
    void externalConsumerCanDeclareAndStartAPublicPlugin() {
        AgentPlugin plugin =
                new AgentPlugin() {
                    @Override
                    public PluginManifest manifest() {
                        return new PluginManifest(
                                "consumer-fixture",
                                "1.0.0",
                                PluginManifest.CURRENT_API_VERSION,
                                Set.of(PluginCapability.TOOL_PROVIDER),
                                Set.of(),
                                Map.of("type", "object"));
                    }

                    @Override
                    public void initialize(PluginContext context) {
                        context.registerTool(new ConsumerTools());
                    }
                };

        try (PluginRegistry registry = new PluginRegistry()) {
            var runtime = registry.register(plugin).start();
            assertEquals(Set.of("consumer_echo"), runtime.toolkit().getToolNames());
            assertEquals(
                    Set.of(
                            PluginCapability.MODEL_PROVIDER,
                            PluginCapability.TOOL_PROVIDER,
                            PluginCapability.MIDDLEWARE,
                            PluginCapability.CONTEXT_SOURCE,
                            PluginCapability.SKILL_REPOSITORY,
                            PluginCapability.SESSION_STORE,
                            PluginCapability.AGENT_STATE_STORE,
                            PluginCapability.FILESYSTEM,
                            PluginCapability.GATEWAY_CHANNEL),
                    Set.of(PluginCapability.values()));
        }
    }

    private static final class ConsumerTools {
        @Tool(name = "consumer_echo", readOnly = true, description = "Consumer fixture tool")
        public ToolResultBlock echo(
                @ToolParam(name = "text", description = "Text to return") String text) {
            return ToolResultBlock.success(text);
        }
    }
}
