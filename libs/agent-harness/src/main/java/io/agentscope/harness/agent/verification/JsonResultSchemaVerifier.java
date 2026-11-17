/*
 * Copyright 2024-2026 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package io.agentscope.harness.agent.verification;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolExecutionDetails;
import io.agentscope.core.message.ToolResultState;
import io.agentscope.core.observation.ActionObservation;
import io.agentscope.core.state.TaskVerification.Outcome;
import io.agentscope.core.util.JsonUtils;
import io.agentscope.harness.agent.observation.StoredActionObservation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Explicit output-contract check; never infers a schema from a natural-language criterion. */
public final class JsonResultSchemaVerifier implements DeterministicVerifier {
    private final String id;
    private final Schema schema;
    private static final ObjectMapper JSON =
            new ObjectMapper()
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .enable(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY)
                    .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final SchemaRegistry SCHEMAS =
            SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12);
    private static final Set<String> DISALLOWED_KEYS =
            Set.of("$ref", "$dynamicRef", "$recursiveRef", "$schema", "$id");

    public JsonResultSchemaVerifier(Map<String, Object> schema) {
        this(JsonUtils.getJsonCodec().toJson(schema));
    }

    /** Compile a user-supplied schema from its original JSON text. */
    public static JsonResultSchemaVerifier fromJson(String schemaJson) {
        return new JsonResultSchemaVerifier(schemaJson);
    }

    private JsonResultSchemaVerifier(String schemaJson) {
        if (schemaJson == null || schemaJson.isBlank())
            throw new IllegalArgumentException("Explicit schema required");
        if (schemaJson.length() > 65536) throw new IllegalArgumentException("Schema too large");
        JsonNode definition;
        try {
            definition = JSON.readTree(schemaJson);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("Expected a single JSON schema object", error);
        }
        if (definition == null || !definition.isObject() || definition.isEmpty())
            throw new IllegalArgumentException("Explicit schema object required");
        rejectReferences(definition);
        var metaSchema = SCHEMAS.getSchema(
                SchemaLocation.of(SpecificationVersion.DRAFT_2020_12.getDialectId()));
        if (!metaSchema.validate(definition).isEmpty())
            throw new IllegalArgumentException("Invalid Draft 2020-12 JSON Schema");
        schema = SCHEMAS.getSchema(definition);
        schema.initializeValidators();
        try {
            id =
                    "json-schema-v2:"
                            + HexFormat.of()
                                    .formatHex(
                                            MessageDigest.getInstance("SHA-256")
                                                    .digest(
                                                            schemaJson.getBytes(
                                                                    StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public String id() {
        return id;
    }

    @Override
    public Verdict verify(StoredActionObservation evidence) {
        var action = evidence.observation();
        var result = evidence.result();
        if (action.status() != ActionObservation.Status.RETURNED
                || result == null
                || (result.getState() != ToolResultState.SUCCESS
                        && result.getState() != ToolResultState.RUNNING)
                || result.isSuspended()
                || !Objects.equals(action.toolCallId(), result.getId())
                || !Objects.equals(action.toolName(), result.getName())
                || result.getOutput().size() != 1
                || !(result.getOutput().get(0) instanceof TextBlock text)) {
            return new Verdict(Outcome.UNKNOWN, "Expected one successful textual JSON result");
        }
        if (result.getExecutionDetails() != null
                && (result.getExecutionDetails().outputTruncated()
                        || result.getExecutionDetails().outcome()
                                != ToolExecutionDetails.Outcome.SUCCEEDED)) {
            return new Verdict(Outcome.UNKNOWN, "Producer outcome is incomplete or unsuccessful");
        }
        return verifySuccessfulOutput(text.getText());
    }

    /** Verify raw output after the caller establishes the producer succeeded and output is complete. */
    public Verdict verifySuccessfulOutput(String output) {
        if (output == null || output.length() > 262144) {
            return new Verdict(
                    Outcome.UNKNOWN, "Output is absent or exceeds the bounded schema-check size");
        }
        JsonNode value;
        try {
            value = JSON.readTree(output);
            if (value == null || value.isMissingNode())
                return new Verdict(Outcome.FAILED, "JSON output is empty");
        } catch (JsonProcessingException error) {
            return new Verdict(Outcome.FAILED, "Output is not a single valid JSON value");
        }
        return schema.validate(value).isEmpty()
                ? new Verdict(
                        Outcome.PASSED, "Selected JSON output conforms to the configured schema")
                : new Verdict(
                        Outcome.FAILED,
                        "Selected output does not conform to the configured JSON schema");
    }

    private static void rejectReferences(JsonNode value) {
        if (value.isObject()) {
            for (var entry : value.properties()) {
                if (DISALLOWED_KEYS.contains(entry.getKey())) {
                    throw new IllegalArgumentException(
                            "Referenced schemas and dialect overrides are not supported by this"
                                    + " bounded offline verifier");
                }
                rejectReferences(entry.getValue());
            }
        } else if (value.isArray()) {
            value.forEach(JsonResultSchemaVerifier::rejectReferences);
        }
    }
}
