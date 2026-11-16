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
package io.agentscope.harness.agent.compatibility;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.MsgRole;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionHeader;
import io.agentscope.core.util.JsonUtils;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

class LegacySessionFixtureTest {

    @Test
    void v1EventEnvelopeAndMessagePayloadRemainReadable() throws Exception {
        ObjectMapper json = new ObjectMapper();
        try (InputStream input =
                getClass()
                        .getResourceAsStream("/compatibility/session-v1.json")) {
            JsonNode fixture = json.readTree(input);
            SessionHeader header = json.treeToValue(fixture.path("header"), SessionHeader.class);
            header.validate();

            SessionEvent first = json.treeToValue(fixture.path("events").get(0), SessionEvent.class);
            SessionEvent second = json.treeToValue(fixture.path("events").get(1), SessionEvent.class);
            Msg user = JsonUtils.getJsonCodec().convertValue(first.data().get("message"), Msg.class);
            Msg assistant =
                    JsonUtils.getJsonCodec()
                            .convertValue(second.data().get("message"), Msg.class);

            assertEquals(MsgRole.USER, user.getRole());
            assertEquals("legacy question", user.getTextContent());
            assertEquals("legacy display", user.getMetadata().get("jharnessDisplay"));
            assertEquals(MsgRole.ASSISTANT, assistant.getRole());
            assertEquals("legacy answer", assistant.getTextContent());
            assertEquals(2, second.seq());
        }
    }
}
