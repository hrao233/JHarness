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

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Explicit launch specification for a trusted, process-isolated plugin. */
public record PluginProcessSpec(
        Path executable,
        List<String> arguments,
        Path workingDirectory,
        Map<String, String> environment,
        Duration startupTimeout,
        Duration requestTimeout,
        Duration shutdownTimeout) {

    public PluginProcessSpec {
        Objects.requireNonNull(executable, "executable");
        Objects.requireNonNull(workingDirectory, "workingDirectory");
        executable = executable.toAbsolutePath().normalize();
        workingDirectory = workingDirectory.toAbsolutePath().normalize();
        arguments = arguments == null ? List.of() : List.copyOf(arguments);
        environment = environment == null ? Map.of() : Map.copyOf(environment);
        startupTimeout = positive(startupTimeout, "startupTimeout");
        requestTimeout = positive(requestTimeout, "requestTimeout");
        shutdownTimeout = positive(shutdownTimeout, "shutdownTimeout");
    }

    /** Creates a Java-style process specification with conservative local timeouts. */
    public static PluginProcessSpec of(
            Path executable, List<String> arguments, Path workingDirectory) {
        return new PluginProcessSpec(
                executable,
                arguments,
                workingDirectory,
                Map.of(),
                Duration.ofSeconds(10),
                Duration.ofSeconds(30),
                Duration.ofSeconds(5));
    }

    private static Duration positive(Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }
}
