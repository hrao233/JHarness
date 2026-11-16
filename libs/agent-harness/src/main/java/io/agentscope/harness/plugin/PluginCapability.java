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

/** Capability slots that a plugin may provide. */
public enum PluginCapability {
    MODEL_PROVIDER(false),
    TOOL_PROVIDER(false),
    MIDDLEWARE(false),
    CONTEXT_SOURCE(false),
    SKILL_REPOSITORY(false),
    SESSION_STORE(true),
    AGENT_STATE_STORE(true),
    FILESYSTEM(true),
    GATEWAY_CHANNEL(false);

    private final boolean singleSelect;

    PluginCapability(boolean singleSelect) {
        this.singleSelect = singleSelect;
    }

    /** Returns whether the host accepts at most one provider for this capability. */
    public boolean singleSelect() {
        return singleSelect;
    }
}
