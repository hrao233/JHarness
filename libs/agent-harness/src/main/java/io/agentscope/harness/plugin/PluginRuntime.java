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
import io.agentscope.core.model.Model;
import io.agentscope.core.model.spi.ModelProvider;
import io.agentscope.core.session.SessionLogStore;
import io.agentscope.core.skill.repository.AgentSkillRepository;
import io.agentscope.core.state.AgentStateStore;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.context.ContextSource;
import io.agentscope.harness.agent.filesystem.AbstractFilesystem;
import io.agentscope.harness.agent.gateway.channel.Channel;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Immutable capability set produced by a started plugin registry. */
public record PluginRuntime(
        Toolkit toolkit,
        List<MiddlewareBase> middlewares,
        List<ModelProvider> modelProviders,
        Map<String, ContextSource> contextSources,
        List<AgentSkillRepository> skillRepositories,
        Map<String, Channel> channels,
        SessionLogStore sessionStore,
        AgentStateStore agentStateStore,
        AbstractFilesystem filesystem) {

    public PluginRuntime {
        Objects.requireNonNull(toolkit, "toolkit");
        middlewares = List.copyOf(middlewares);
        modelProviders = List.copyOf(modelProviders);
        contextSources =
                Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(contextSources)));
        skillRepositories = List.copyOf(skillRepositories);
        channels = Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(channels)));
    }

    /** Applies registered capabilities to a harness builder. */
    public HarnessAgent.Builder applyTo(HarnessAgent.Builder builder) {
        Objects.requireNonNull(builder, "builder");
        builder.toolkit(toolkit);
        builder.middlewares(middlewares);
        contextSources.forEach(builder::contextSource);
        skillRepositories.forEach(builder::skillRepository);
        if (sessionStore != null) {
            builder.sessionLogStore(sessionStore);
        }
        if (agentStateStore != null) {
            builder.stateStore(agentStateStore);
        }
        if (filesystem != null) {
            builder.abstractFilesystem(filesystem);
        }
        return builder;
    }

    /** Binds all registered gateway channels to a harness agent. */
    public void applyChannels(HarnessAgent agent) {
        Objects.requireNonNull(agent, "agent");
        channels.values().forEach(agent::channel);
    }

    /** Creates a model from the first provider that claims the supplied model id. */
    public Model createModel(String modelId) {
        if (modelId == null || modelId.isBlank()) {
            throw new IllegalArgumentException("Model id must not be blank");
        }
        return modelProviders.stream()
                .filter(provider -> provider.supports(modelId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("No plugin model provider for " + modelId))
                .create(modelId);
    }
}
