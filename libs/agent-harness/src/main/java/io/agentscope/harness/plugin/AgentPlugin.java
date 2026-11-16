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

/**
 * In-process plugin contract.
 *
 * <p>Plugins register only declared capabilities through {@link PluginContext}. The host owns
 * discovery, lifecycle order and shutdown.
 */
public interface AgentPlugin {

    PluginManifest manifest();

    /** Validates configuration and registers capabilities. */
    default void initialize(PluginContext context) {}

    /** Starts session-scoped resources after all declared dependencies initialized. */
    default void start(PluginContext context) {}

    /** Stops resources owned by this plugin. Implementations must tolerate partial startup. */
    default void stop(PluginContext context) {}
}
