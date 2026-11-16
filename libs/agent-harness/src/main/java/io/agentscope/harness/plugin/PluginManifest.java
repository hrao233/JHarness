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

import java.util.Map;
import java.util.Set;

/** Stable metadata declared by a plugin before initialization. */
public record PluginManifest(
        String id,
        String version,
        int apiVersion,
        Set<PluginCapability> capabilities,
        Set<String> dependencies,
        Map<String, Object> settingsSchema) {

    public static final int CURRENT_API_VERSION = 1;

    public PluginManifest {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("Plugin id must not be blank");
        }
        if (!id.matches("[a-zA-Z0-9][a-zA-Z0-9._-]*")) {
            throw new IllegalArgumentException("Plugin id contains unsupported characters: " + id);
        }
        if (version == null || version.isBlank()) {
            throw new IllegalArgumentException("Plugin version must not be blank");
        }
        if (apiVersion <= 0) {
            throw new IllegalArgumentException("Plugin API version must be positive");
        }
        capabilities = capabilities == null ? Set.of() : Set.copyOf(capabilities);
        dependencies = dependencies == null ? Set.of() : Set.copyOf(dependencies);
        settingsSchema = settingsSchema == null ? Map.of() : Map.copyOf(settingsSchema);
        if (dependencies.contains(id)) {
            throw new IllegalArgumentException("Plugin cannot depend on itself: " + id);
        }
    }

    /** Creates a manifest without dependencies or a settings schema. */
    public PluginManifest(
            String id,
            String version,
            int apiVersion,
            Set<PluginCapability> capabilities,
            Set<String> dependencies) {
        this(id, version, apiVersion, capabilities, dependencies, Map.of());
    }

    /** Creates a manifest for the current plugin API version. */
    public static PluginManifest of(
            String id, String version, Set<PluginCapability> capabilities) {
        return new PluginManifest(
                id, version, CURRENT_API_VERSION, capabilities, Set.of(), Map.of());
    }
}
