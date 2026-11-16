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
import io.agentscope.harness.agent.context.ContextSource;
import io.agentscope.harness.agent.filesystem.AbstractFilesystem;
import io.agentscope.harness.agent.gateway.channel.Channel;

/** Capability-scoped registration surface passed to a plugin. */
public interface PluginContext {

    String pluginId();

    void registerTool(Object tool);

    void registerMiddleware(MiddlewareBase middleware);

    void registerModelProvider(ModelProvider provider);

    void registerContextSource(String id, ContextSource source);

    void registerSkillRepository(AgentSkillRepository repository);

    void registerSessionStore(SessionLogStore store);

    void registerAgentStateStore(AgentStateStore store);

    void registerFilesystem(AbstractFilesystem filesystem);

    void registerChannel(Channel channel);
}
