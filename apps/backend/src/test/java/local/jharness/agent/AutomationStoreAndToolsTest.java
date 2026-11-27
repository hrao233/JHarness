package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.message.ToolResultState;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AutomationStoreAndToolsTest {
    @TempDir Path temp;

    @Test
    void resolvesSharedFileRelativeToWorkspacesParent() {
        Path workspaces = temp.resolve("userData").resolve("workspaces");
        assertEquals(
                temp.resolve("userData").resolve("automations.json").toAbsolutePath().normalize(),
                AutomationStore.resolveDefaultFile(workspaces));
        Path standalone = temp.resolve("data");
        assertEquals(
                standalone.resolve("automations.json").toAbsolutePath().normalize(),
                AutomationStore.resolveDefaultFile(standalone));
    }

    @Test
    void computesDailyAndWeekdaySchedulesDeterministically() {
        ZoneId zone = ZoneId.of("Asia/Shanghai");
        // 2026-11-27 is Friday (ISO day 5).
        long fridayEvening = ZonedDateTime.of(2026, 11, 27, 18, 40, 0, 0, zone).toInstant().toEpochMilli();
        long sameDayNight = AutomationStore.nextDailyRun(fridayEvening, "21:15", List.of(), zone);
        assertEquals(
                ZonedDateTime.of(2026, 11, 27, 21, 15, 0, 0, zone).toInstant().toEpochMilli(),
                sameDayNight);

        long nextMorning = AutomationStore.nextDailyRun(fridayEvening, "09:00", List.of(), zone);
        assertEquals(
                ZonedDateTime.of(2026, 11, 28, 9, 0, 0, 0, zone).toInstant().toEpochMilli(),
                nextMorning);

        // Monday (1) and Wednesday (3) only -> from Friday 18:40 should jump to Monday 2026-11-30 09:00.
        long nextWeekday = AutomationStore.nextDailyRun(fridayEvening, "09:00", List.of(1, 3), zone);
        assertEquals(
                ZonedDateTime.of(2026, 11, 30, 9, 0, 0, 0, zone).toInstant().toEpochMilli(),
                nextWeekday);
    }

    @Test
    void toolsValidateBeforeApprovalEnforceProjectScopeAndEmitEvents() throws Exception {
        Path file = temp.resolve("automations.json");
        var store = new AutomationStore(file);
        var allowApproval = new AtomicBoolean(true);
        var approvalCalls = new AtomicInteger();
        var events = new ArrayList<Map<String, Object>>();
        ApprovedOperation approval = (operation, path, before, after, deniedMessage, action) -> {
            approvalCalls.incrementAndGet();
            if (!allowApproval.get()) {
                return io.agentscope.core.message.ToolResultBlock.error(deniedMessage);
            }
            return action.get();
        };

        var projectATools = new AutomationTools(store, "project-a", approval, (type, data) -> {
            assertEquals("automation-changed", type);
            events.add(data);
        });
        var projectBTools = new AutomationTools(store, "project-b", approval, (type, data) -> {});

        // Validation errors must not trigger user approval cards.
        var badSchedule = projectATools.create("Bad", "Prompt", "hourly", null, null, null, null, null);
        assertEquals(ToolResultState.ERROR, badSchedule.getState());
        assertEquals(0, approvalCalls.get());

        var badTime = projectATools.create("Bad time", "Prompt", "daily", null, "25:00", null, null, null);
        assertEquals(ToolResultState.ERROR, badTime.getState());
        assertEquals(0, approvalCalls.get());

        // Denied approval leaves store empty.
        allowApproval.set(false);
        var denied = projectATools.create(
                "每日搜索 angle-core 论文",
                "检索最新 angle-core 相关论文并附上 https:// 链接。",
                "daily",
                null,
                "09:00",
                List.of(1, 3, 5),
                null,
                null);
        assertEquals(ToolResultState.ERROR, denied.getState());
        assertEquals(1, approvalCalls.get());
        assertTrue(store.list("project-a").definitions().isEmpty());
        assertTrue(events.isEmpty());

        // Approved creation persists and emits change event.
        allowApproval.set(true);
        var created = projectATools.create(
                "每日搜索 angle-core 论文",
                "检索最新 angle-core 相关论文并附上 https:// 链接。",
                "daily",
                null,
                "09:00",
                List.of(1, 3, 5),
                null,
                null);
        assertEquals(ToolResultState.SUCCESS, created.getState());
        assertEquals(1, events.size());
        assertEquals("created", events.get(0).get("action"));

        var listA = store.list("project-a").definitions();
        assertEquals(1, listA.size());
        String id = listA.get(0).id();
        assertEquals("daily", listA.get(0).scheduleType());
        assertEquals("09:00", listA.get(0).timeOfDay());
        assertEquals(List.of(1, 3, 5), listA.get(0).daysOfWeek());
        ToolResultBlock listedBlock = projectATools.list();
        String listedText = ((TextBlock) listedBlock.getOutput().get(0)).getText();
        assertTrue(listedText.contains("每日搜索 angle-core 论文"));

        // Project B cannot see, update, or delete Project A's automation.
        assertTrue(store.list("project-b").definitions().isEmpty());
        assertEquals(ToolResultState.ERROR, projectBTools.delete(id).getState());

        // Pause and update schedule to interval.
        var paused = projectATools.update(id, false, null, null, "interval", 120, null, null, null, null);
        assertEquals(ToolResultState.SUCCESS, paused.getState());
        var updatedDef = store.get("project-a", id);
        assertFalse(updatedDef.enabled());
        assertEquals("interval", updatedDef.scheduleType());
        assertEquals(120, updatedDef.intervalMinutes());

        // Active run blocks deletion while preserving run records.
        var mapper = new ObjectMapper();
        var rootNode = (com.fasterxml.jackson.databind.node.ObjectNode)
                mapper.readTree(Files.readString(file, StandardCharsets.UTF_8));
        rootNode.withArray("runs").add(mapper.valueToTree(new AutomationStore.RunRecord(
                "run-rec-1",
                id,
                updatedDef.name(),
                "project-a",
                updatedDef.sessionId(),
                "schedule",
                System.currentTimeMillis(),
                "running",
                "live-run-1",
                System.currentTimeMillis(),
                0L,
                "")));
        Files.writeString(file, mapper.writeValueAsString(rootNode), StandardCharsets.UTF_8);
        assertThrows(IllegalStateException.class, () -> store.remove("project-a", id));

        // Mark run completed, then delete definition via tool.
        ((com.fasterxml.jackson.databind.node.ObjectNode) rootNode.withArray("runs").get(0))
                .put("status", "completed");
        Files.writeString(file, mapper.writeValueAsString(rootNode), StandardCharsets.UTF_8);
        var deleted = projectATools.delete(id);
        assertEquals(ToolResultState.SUCCESS, deleted.getState());
        assertTrue(store.list("project-a").definitions().isEmpty());
        assertEquals(1, store.list("project-a").runs().size());
    }
}
