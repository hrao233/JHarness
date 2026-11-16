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

import io.agentscope.core.middleware.MiddlewareBase;
import io.agentscope.core.model.spi.ModelProvider;
import io.agentscope.core.session.SessionLogStore;
import io.agentscope.core.skill.repository.AgentSkillRepository;
import io.agentscope.core.state.AgentStateStore;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.context.ContextSource;
import io.agentscope.harness.agent.filesystem.AbstractFilesystem;
import io.agentscope.harness.agent.gateway.channel.Channel;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceLoader;
import java.util.Set;

/**
 * Deterministic in-process plugin host.
 *
 * <p>No project-directory scanning is performed. Callers must explicitly register plugins or load
 * trusted service providers from an application-controlled class loader.
 */
public final class PluginRegistry implements AutoCloseable {

    private final LinkedHashMap<String, AgentPlugin> plugins = new LinkedHashMap<>();
    private final Map<String, PluginContext> contexts = new HashMap<>();
    private final List<AgentPlugin> startupOrder = new ArrayList<>();
    private final Toolkit toolkit = new Toolkit();
    private final List<MiddlewareBase> middlewares = new ArrayList<>();
    private final List<ModelProvider> modelProviders = new ArrayList<>();
    private final Map<String, ContextSource> contextSources = new LinkedHashMap<>();
    private final List<AgentSkillRepository> skillRepositories = new ArrayList<>();
    private final Map<String, Channel> channels = new LinkedHashMap<>();
    private SessionLogStore sessionStore;
    private AgentStateStore agentStateStore;
    private AbstractFilesystem filesystem;
    private PluginRuntime runtime;

    /** Adds a plugin before startup. */
    public synchronized PluginRegistry register(AgentPlugin plugin) {
        Objects.requireNonNull(plugin, "plugin");
        PluginManifest manifest = Objects.requireNonNull(plugin.manifest(), "plugin manifest");
        if (runtime != null) {
            throw new IllegalStateException("Cannot register plugins after startup");
        }
        if (plugins.putIfAbsent(manifest.id(), plugin) != null) {
            throw new IllegalArgumentException("Duplicate plugin id: " + manifest.id());
        }
        return this;
    }

    /** Discovers trusted plugins from the supplied class loader. */
    public synchronized int discover(ClassLoader classLoader) {
        int before = plugins.size();
        ServiceLoader.load(AgentPlugin.class, classLoader).forEach(this::register);
        return plugins.size() - before;
    }

    /** Starts all registered plugins in dependency order and returns the capability runtime. */
    public synchronized PluginRuntime start() {
        if (runtime != null) {
            return runtime;
        }
        List<AgentPlugin> ordered = resolveOrder();
        try {
            for (AgentPlugin plugin : ordered) {
                PluginManifest manifest = plugin.manifest();
                if (manifest.apiVersion() != PluginManifest.CURRENT_API_VERSION) {
                    throw new PluginLoadException(
                            "Plugin "
                                    + manifest.id()
                                    + " requires API version "
                                    + manifest.apiVersion()
                                    + " but host supports "
                                    + PluginManifest.CURRENT_API_VERSION);
                }
                PluginContext context = new DefaultPluginContext(manifest);
                contexts.put(manifest.id(), context);
                plugin.initialize(context);
                plugin.start(context);
                startupOrder.add(plugin);
            }
            runtime =
                    new PluginRuntime(
                            toolkit,
                            middlewares,
                            modelProviders,
                            contextSources,
                            skillRepositories,
                            channels,
                            sessionStore,
                            agentStateStore,
                            filesystem);
            return runtime;
        } catch (RuntimeException error) {
            stopStarted();
            throw error instanceof PluginLoadException loadError
                    ? loadError
                    : new PluginLoadException("Failed to start plugins", error);
        }
    }

    /** Returns the started capability runtime. */
    public synchronized PluginRuntime runtime() {
        if (runtime == null) {
            throw new IllegalStateException("Plugin registry has not started");
        }
        return runtime;
    }

    @Override
    public synchronized void close() {
        stopStarted();
        runtime = null;
    }

    private void stopStarted() {
        RuntimeException failure = null;
        List<AgentPlugin> reverse = new ArrayList<>(startupOrder);
        Collections.reverse(reverse);
        for (AgentPlugin plugin : reverse) {
            PluginContext context = contexts.get(plugin.manifest().id());
            try {
                plugin.stop(context);
            } catch (RuntimeException error) {
                if (failure == null) {
                    failure = error;
                } else {
                    failure.addSuppressed(error);
                }
            }
        }
        startupOrder.clear();
        contexts.clear();
        if (failure != null) {
            throw failure;
        }
    }

    private List<AgentPlugin> resolveOrder() {
        List<AgentPlugin> ordered = new ArrayList<>();
        Set<String> visiting = new LinkedHashSet<>();
        Set<String> visited = new HashSet<>();
        for (String id : plugins.keySet()) {
            visit(id, visiting, visited, ordered);
        }
        return ordered;
    }

    private void visit(
            String id, Set<String> visiting, Set<String> visited, List<AgentPlugin> ordered) {
        if (visited.contains(id)) {
            return;
        }
        AgentPlugin plugin = plugins.get(id);
        if (plugin == null) {
            throw new PluginLoadException("Missing plugin dependency: " + id);
        }
        if (!visiting.add(id)) {
            throw new PluginLoadException("Plugin dependency cycle at " + id);
        }
        plugin.manifest().dependencies().stream()
                .sorted()
                .forEach(dependency -> visit(dependency, visiting, visited, ordered));
        visiting.remove(id);
        visited.add(id);
        ordered.add(plugin);
    }

    private final class DefaultPluginContext implements PluginContext {
        private final PluginManifest manifest;

        private DefaultPluginContext(PluginManifest manifest) {
            this.manifest = manifest;
        }

        @Override
        public String pluginId() {
            return manifest.id();
        }

        @Override
        public void registerTool(Object tool) {
            require(PluginCapability.TOOL_PROVIDER);
            Objects.requireNonNull(tool, "tool");
            toolkit.registerTool(tool);
        }

        @Override
        public void registerMiddleware(MiddlewareBase middleware) {
            require(PluginCapability.MIDDLEWARE);
            middlewares.add(Objects.requireNonNull(middleware, "middleware"));
        }

        @Override
        public void registerModelProvider(ModelProvider provider) {
            require(PluginCapability.MODEL_PROVIDER);
            Objects.requireNonNull(provider, "provider");
            if (modelProviders.stream()
                    .anyMatch(existing -> existing.providerId().equals(provider.providerId()))) {
                throw new IllegalArgumentException(
                        "Duplicate model provider: " + provider.providerId());
            }
            modelProviders.add(provider);
        }

        @Override
        public void registerContextSource(String id, ContextSource source) {
            require(PluginCapability.CONTEXT_SOURCE);
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("Context source id must not be blank");
            }
            if (contextSources.putIfAbsent(id, Objects.requireNonNull(source, "source")) != null) {
                throw new IllegalArgumentException("Duplicate context source: " + id);
            }
        }

        @Override
        public void registerSkillRepository(AgentSkillRepository repository) {
            require(PluginCapability.SKILL_REPOSITORY);
            skillRepositories.add(Objects.requireNonNull(repository, "repository"));
        }

        @Override
        public void registerSessionStore(SessionLogStore store) {
            require(PluginCapability.SESSION_STORE);
            sessionStore = single("session store", sessionStore, store);
        }

        @Override
        public void registerAgentStateStore(AgentStateStore store) {
            require(PluginCapability.AGENT_STATE_STORE);
            agentStateStore = single("agent state store", agentStateStore, store);
        }

        @Override
        public void registerFilesystem(AbstractFilesystem value) {
            require(PluginCapability.FILESYSTEM);
            filesystem = single("filesystem", filesystem, value);
        }

        @Override
        public void registerChannel(Channel channel) {
            require(PluginCapability.GATEWAY_CHANNEL);
            Objects.requireNonNull(channel, "channel");
            String channelId = channel.channelId();
            if (channelId == null || channelId.isBlank()) {
                throw new IllegalArgumentException("Channel id must not be blank");
            }
            if (channels.putIfAbsent(channelId, channel) != null) {
                throw new IllegalArgumentException("Duplicate channel: " + channelId);
            }
        }

        private <T> T single(String label, T existing, T value) {
            Objects.requireNonNull(value, label);
            if (existing != null) {
                throw new IllegalStateException("Duplicate " + label + " registration");
            }
            return value;
        }

        private void require(PluginCapability capability) {
            if (!manifest.capabilities().contains(capability)) {
                throw new IllegalStateException(
                        "Plugin " + manifest.id() + " did not declare capability " + capability);
            }
        }
    }
}
