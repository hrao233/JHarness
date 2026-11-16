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
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Hosts one explicitly trusted plugin in a separate process using a JSON-line request protocol.
 *
 * <p>The child process owns stdout exclusively for protocol responses. Diagnostics must be written
 * to stderr. No project directory is scanned and no shell is involved in launching the executable.
 */
public final class PluginProcessHost implements AutoCloseable {

    private final Process process;
    private final BufferedWriter input;
    private final BufferedReader output;
    private final ObjectMapper json = new ObjectMapper();
    private final AtomicLong requestIds = new AtomicLong();
    private final Duration requestTimeout;
    private final Duration shutdownTimeout;
    private final ExecutorService reader;
    private final StringBuilder diagnostics = new StringBuilder();
    private volatile boolean closed;

    private PluginProcessHost(
            Process process,
            Duration requestTimeout,
            Duration shutdownTimeout,
            Duration startupTimeout)
            throws Exception {
        this.process = process;
        this.requestTimeout = requestTimeout;
        this.shutdownTimeout = shutdownTimeout;
        input =
                new BufferedWriter(
                        new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        output =
                new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        ThreadFactory factory =
                runnable -> {
                    Thread thread = new Thread(runnable, "jharness-plugin-process");
                    thread.setDaemon(true);
                    return thread;
                };
        reader = Executors.newSingleThreadExecutor(factory);
        Thread diagnosticsReader = new Thread(this::drainDiagnostics, "jharness-plugin-stderr");
        diagnosticsReader.setDaemon(true);
        diagnosticsReader.start();
        long readinessWindow = Math.min(250, startupTimeout.toMillis());
        if (process.waitFor(readinessWindow, TimeUnit.MILLISECONDS)) {
            throw new PluginProcessException("Plugin process failed to start");
        }
    }

    /** Starts a process from an explicit specification. */
    public static PluginProcessHost start(PluginProcessSpec spec) {
        Objects.requireNonNull(spec, "spec");
        if (!Files.isRegularFile(spec.executable())) {
            throw new IllegalArgumentException("Plugin executable is not a regular file");
        }
        if (!Files.isDirectory(spec.workingDirectory())) {
            throw new IllegalArgumentException("Plugin working directory does not exist");
        }
        ProcessBuilder builder =
                new ProcessBuilder(
                                java.util.stream.Stream.concat(
                                                java.util.stream.Stream.of(
                                                        spec.executable().toString()),
                                                spec.arguments().stream())
                                        .toList())
                        .directory(spec.workingDirectory().toFile());
        builder.environment().putAll(spec.environment());
        try {
            return new PluginProcessHost(
                    builder.start(),
                    spec.requestTimeout(),
                    spec.shutdownTimeout(),
                    spec.startupTimeout());
        } catch (Exception error) {
            throw new PluginProcessException("Failed to start plugin process", error);
        }
    }

    /** Returns whether this process is alive and still accepting requests. */
    public boolean isAlive() {
        return !closed && process.isAlive();
    }

    /** Returns the operating-system process id. */
    public long pid() {
        return process.pid();
    }

    /** Returns bounded stderr text for diagnostics. */
    public String diagnostics() {
        synchronized (diagnostics) {
            return diagnostics.toString();
        }
    }

    /**
     * Sends one request and returns the result node from the matching response.
     *
     * <p>Response shape: {@code {"id":"...","result":...}} or {@code
     * {"id":"...","error":"..."}}.
     */
    public JsonNode request(String method, Map<String, Object> params) {
        if (method == null || method.isBlank()) {
            throw new IllegalArgumentException("Plugin method must not be blank");
        }
        synchronized (this) {
            ensureOpen();
            String id = Long.toString(requestIds.incrementAndGet());
            try {
                input.write(
                        json.writeValueAsString(
                                Map.of(
                                        "id",
                                        id,
                                        "method",
                                        method,
                                        "params",
                                        params == null ? Map.of() : params)));
                input.newLine();
                input.flush();
                Future<JsonNode> response = reader.submit(() -> readResponse(id));
                return response.get(requestTimeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (ExecutionException error) {
                Throwable cause = error.getCause();
                throw new PluginProcessException(
                        "Plugin request failed: "
                                + method
                                + ": "
                                + (cause == null ? error.getMessage() : cause.getMessage()),
                        cause);
            } catch (TimeoutException error) {
                throw new PluginProcessException("Plugin request timed out: " + method, error);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new PluginProcessException("Plugin request interrupted: " + method, error);
            } catch (IOException error) {
                throw new PluginProcessException("Plugin protocol write failed: " + method, error);
            }
        }
    }

    private JsonNode readResponse(String id) throws IOException {
        while (true) {
            String line = output.readLine();
            if (line == null) {
                throw new PluginProcessException(
                        "Plugin process exited before responding. " + diagnostics());
            }
            JsonNode response;
            try {
                response = json.readTree(line);
            } catch (IOException error) {
                throw new PluginProcessException("Plugin emitted invalid JSON: " + line, error);
            }
            if (response == null || !response.isObject()) {
                throw new PluginProcessException("Plugin response must be a JSON object");
            }
            if (!id.equals(response.path("id").asText())) {
                continue;
            }
            if (response.hasNonNull("error")) {
                throw new PluginProcessException(response.path("error").asText());
            }
            return response.get("result");
        }
    }

    private void drainDiagnostics() {
        try (BufferedReader error =
                new BufferedReader(
                        new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = error.readLine()) != null) {
                synchronized (diagnostics) {
                    diagnostics.append(line).append('\n');
                    if (diagnostics.length() > 8192) {
                        diagnostics.delete(0, diagnostics.length() - 8192);
                    }
                }
            }
        } catch (IOException ignored) {
            // Process shutdown closes this stream.
        }
    }

    private void ensureOpen() {
        if (closed || !process.isAlive()) {
            throw new PluginProcessException(
                    "Plugin process is not running. " + diagnostics());
        }
    }

    @Override
    public synchronized void close() {
        if (closed) {
            return;
        }
        try {
            input.write(json.writeValueAsString(Map.of("id", "shutdown", "method", "shutdown")));
            input.newLine();
            input.flush();
        } catch (IOException ignored) {
            // The process may already have stopped.
        }
        closed = true;
        try {
            if (!process.waitFor(shutdownTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroy();
                if (!process.waitFor(shutdownTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                }
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        } finally {
            reader.shutdownNow();
        }
    }
}
