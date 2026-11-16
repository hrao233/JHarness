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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.model.Model;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.model.spi.ModelProvider;
import io.agentscope.core.session.SessionLogStore;
import io.agentscope.core.skill.repository.AgentSkillRepository;
import io.agentscope.core.state.AgentStateStore;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import io.agentscope.harness.agent.context.ContextBlock;
import io.agentscope.harness.agent.filesystem.AbstractFilesystem;
import io.agentscope.harness.agent.gateway.channel.Channel;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

class PluginRegistryTest {

    private static final List<String> lifecycle = new ArrayList<>();

    @Test
    void startsDependenciesFirstAndRegistersDeclaredCapabilities() {
        lifecycle.clear();
        FakePlugin dependency = new FakePlugin("dependency", Set.of());
        FakePlugin capabilities =
                new FakePlugin(
                        "capabilities",
                        Set.of(
                                PluginCapability.TOOL_PROVIDER,
                                PluginCapability.MIDDLEWARE,
                                PluginCapability.MODEL_PROVIDER,
                                PluginCapability.CONTEXT_SOURCE));
        capabilities.dependencies = Set.of("dependency");

        try (PluginRegistry registry = new PluginRegistry()) {
            registry.register(capabilities).register(dependency);
            PluginRuntime runtime = registry.start();

            assertEquals(List.of("dependency", "capabilities"), lifecycle);
            assertEquals(Set.of("plugin_echo"), runtime.toolkit().getToolNames());
            assertEquals(1, runtime.middlewares().size());
            assertEquals(1, runtime.modelProviders().size());
            assertEquals(1, runtime.contextSources().size());
        }
    }

    @Test
    void rejectsUndeclaredCapability() {
        FakePlugin plugin = new FakePlugin("invalid", Set.of());
        plugin.attemptUndeclaredRegistration = true;
        try (PluginRegistry registry = new PluginRegistry()) {
            registry.register(plugin);
            PluginLoadException error =
                    assertThrows(PluginLoadException.class, registry::start);
            assertEquals(true, error.getCause() instanceof IllegalStateException);
        }
    }

    @Test
    void rejectsMissingDependency() {
        FakePlugin plugin = new FakePlugin("missing", Set.of());
        plugin.dependencies = Set.of("absent");
        try (PluginRegistry registry = new PluginRegistry()) {
            registry.register(plugin);
            assertThrows(PluginLoadException.class, registry::start);
        }
    }

    @Test
    void registersEveryCapabilitySlot() {
        FakePlugin plugin =
                new FakePlugin(
                        "all",
                        Set.of(
                                PluginCapability.TOOL_PROVIDER,
                                PluginCapability.MIDDLEWARE,
                                PluginCapability.MODEL_PROVIDER,
                                PluginCapability.CONTEXT_SOURCE,
                                PluginCapability.SKILL_REPOSITORY,
                                PluginCapability.SESSION_STORE,
                                PluginCapability.AGENT_STATE_STORE,
                                PluginCapability.FILESYSTEM,
                                PluginCapability.GATEWAY_CHANNEL));

        try (PluginRegistry registry = new PluginRegistry()) {
            PluginRuntime runtime = registry.register(plugin).start();

            assertEquals(Set.of("plugin_echo"), runtime.toolkit().getToolNames());
            assertEquals(1, runtime.middlewares().size());
            assertEquals(1, runtime.modelProviders().size());
            assertEquals(Set.of("fixture"), runtime.contextSources().keySet());
            assertEquals(List.of(plugin.skillRepository), runtime.skillRepositories());
            assertSame(plugin.sessionStore, runtime.sessionStore());
            assertSame(plugin.agentStateStore, runtime.agentStateStore());
            assertSame(plugin.filesystem, runtime.filesystem());
            assertEquals(Set.of("fixture-channel"), runtime.channels().keySet());
        }
    }

    @Test
    void rejectsDuplicateSingleSelectCapability() {
        FakePlugin first = new FakePlugin("first", Set.of(PluginCapability.SESSION_STORE));
        FakePlugin second = new FakePlugin("second", Set.of(PluginCapability.SESSION_STORE));

        try (PluginRegistry registry = new PluginRegistry()) {
            registry.register(first).register(second);
            PluginLoadException error = assertThrows(PluginLoadException.class, registry::start);
            assertEquals(true, error.getCause() instanceof IllegalStateException);
        }
    }

    @Test
    void preservesSettingsSchemaInManifest() {
        Map<String, Object> schema =
                Map.of(
                        "type", "object",
                        "required", List.of("endpoint"));

        PluginManifest manifest =
                new PluginManifest(
                        "configured",
                        "1.0.0",
                        PluginManifest.CURRENT_API_VERSION,
                        Set.of(PluginCapability.MODEL_PROVIDER),
                        Set.of(),
                        schema);

        assertEquals(schema, manifest.settingsSchema());
    }

    private static final class FakePlugin implements AgentPlugin {
        private final PluginManifest manifest;
        private final AgentSkillRepository skillRepository = mock(AgentSkillRepository.class);
        private final SessionLogStore sessionStore = mock(SessionLogStore.class);
        private final AgentStateStore agentStateStore = mock(AgentStateStore.class);
        private final AbstractFilesystem filesystem = mock(AbstractFilesystem.class);
        private final Channel channel = mock(Channel.class);
        private Set<String> dependencies = Set.of();
        private boolean attemptUndeclaredRegistration;

        private FakePlugin(String id, Set<PluginCapability> capabilities) {
            when(channel.channelId()).thenReturn("fixture-channel");
            this.manifest =
                    new PluginManifest(
                            id,
                            "1.0.0",
                            PluginManifest.CURRENT_API_VERSION,
                            capabilities,
                            dependencies);
        }

        @Override
        public PluginManifest manifest() {
            return new PluginManifest(
                    manifest.id(),
                    manifest.version(),
                    manifest.apiVersion(),
                    manifest.capabilities(),
                    dependencies);
        }

        @Override
        public void initialize(PluginContext context) {
            if (attemptUndeclaredRegistration) {
                context.registerTool(new EchoTools());
                return;
            }
            if (manifest.capabilities().contains(PluginCapability.TOOL_PROVIDER)) {
                context.registerTool(new EchoTools());
            }
            if (manifest.capabilities().contains(PluginCapability.MIDDLEWARE)) {
                context.registerMiddleware(
                        new MiddlewareBase() {
                            @Override
                            public Set<ExtensionPoint> activePoints() {
                                return Set.of();
                            }
                        });
            }
            if (manifest.capabilities().contains(PluginCapability.MODEL_PROVIDER)) {
                context.registerModelProvider(new FakeModelProvider());
            }
            if (manifest.capabilities().contains(PluginCapability.CONTEXT_SOURCE)) {
                context.registerContextSource(
                        "fixture",
                        request ->
                                Mono.just(
                                        List.of(ContextBlock.reference("fixture", "value"))));
            }
            if (manifest.capabilities().contains(PluginCapability.SKILL_REPOSITORY)) {
                context.registerSkillRepository(skillRepository);
            }
            if (manifest.capabilities().contains(PluginCapability.SESSION_STORE)) {
                context.registerSessionStore(sessionStore);
            }
            if (manifest.capabilities().contains(PluginCapability.AGENT_STATE_STORE)) {
                context.registerAgentStateStore(agentStateStore);
            }
            if (manifest.capabilities().contains(PluginCapability.FILESYSTEM)) {
                context.registerFilesystem(filesystem);
            }
            if (manifest.capabilities().contains(PluginCapability.GATEWAY_CHANNEL)) {
                context.registerChannel(channel);
            }
        }

        @Override
        public void start(PluginContext context) {
            lifecycle.add(manifest.id());
        }
    }

    private static final class EchoTools {
        @Tool(name = "plugin_echo", readOnly = true, description = "Echo plugin input")
        public ToolResultBlock echo(
                @ToolParam(name = "text", description = "Text to echo") String text) {
            return ToolResultBlock.success(text);
        }
    }

    private static final class FakeModelProvider implements ModelProvider {
        @Override
        public String providerId() {
            return "fixture";
        }

        @Override
        public boolean supports(String modelId) {
            return modelId != null && modelId.startsWith("fixture:");
        }

        @Override
        public Model create(String modelId) {
            return mock(Model.class);
        }
    }
}
