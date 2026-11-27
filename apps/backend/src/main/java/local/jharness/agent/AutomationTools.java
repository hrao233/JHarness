package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiConsumer;

/**
 * Project-scoped tools that let the JHarness assistant inspect and manage scheduled automations.
 */
public final class AutomationTools {
    private static final DateTimeFormatter SPACE_DATE_TIME =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");
    private static final DateTimeFormatter SPACE_DATE_TIME_SECONDS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final AutomationStore store;
    private final String projectId;
    private final ApprovedOperation approval;
    private final BiConsumer<String, Map<String, Object>> notifyChanged;

    public AutomationTools(
            AutomationStore store,
            String projectId,
            ApprovedOperation approval,
            BiConsumer<String, Map<String, Object>> notifyChanged) {
        this.store = store;
        this.projectId = projectId;
        this.approval = approval;
        this.notifyChanged = notifyChanged;
    }

    @Tool(
            name = "automation_list",
            readOnly = true,
            description = "List scheduled automated tasks (interval, daily, or one-shot) and recent run status for the current project.")
    public ToolResultBlock list() {
        try {
            ZoneId zone = ZoneId.systemDefault();
            var snapshot = store.list(projectId);
            if (snapshot.definitions().isEmpty()) {
                return ToolResultBlock.success("当前项目暂无定时自动任务。");
            }
            var lines = new ArrayList<String>();
            for (var item : snapshot.definitions()) {
                var latestRun = snapshot.runs().stream()
                        .filter(run -> item.id().equals(run.automationId()))
                        .findFirst()
                        .orElse(null);
                String status = item.enabled()
                        ? "已启用 · 下次执行 " + AutomationStore.formatEpoch(item.nextRunAt(), zone)
                        : "已暂停";
                String runNote = latestRun == null
                        ? "尚无运行记录"
                        : "最近运行 " + latestRun.status()
                                + "（" + AutomationStore.formatEpoch(
                                        latestRun.startedAt() > 0 ? latestRun.startedAt() : latestRun.scheduledFor(),
                                        zone) + "）";
                lines.add("- ID: " + item.id()
                        + "\n  名称: " + item.name()
                        + "\n  计划: " + AutomationStore.describeSchedule(item, zone) + " · " + status
                        + "\n  关联会话: " + item.sessionId()
                        + "\n  运行状态: " + runNote
                        + "\n  任务内容: " + item.prompt());
            }
            return ToolResultBlock.success(String.join("\n", lines));
        } catch (RuntimeException error) {
            return ToolResultBlock.error(messageOf(error, "无法读取自动任务列表。"));
        }
    }

    @Tool(
            name = "automation_create",
            concurrencySafe = false,
            description = """
                    Create a scheduled automated task for the current project after user approval.
                    Supports fixed intervals (schedule_type='interval' with interval_minutes),
                    daily or weekday schedules (schedule_type='daily' with time_of_day='HH:mm' and optional days_of_week 1=Mon..7=Sun),
                    or one-time execution (schedule_type='once' with delay_minutes or run_at).
                    Each automation gets an isolated durable conversation in the current project and runs while JHarness Desktop is open.
                    """)
    public ToolResultBlock create(
            @ToolParam(name = "name", description = "Short descriptive task name (up to 80 chars)") String name,
            @ToolParam(
                            name = "prompt",
                            description = "Self-contained instructions executed by the agent on every scheduled run")
                    String prompt,
            @ToolParam(name = "schedule_type", description = "Schedule mode: interval, daily, or once")
                    String scheduleType,
            @ToolParam(
                            name = "interval_minutes",
                            description = "Interval in minutes (1-10080) when schedule_type is interval",
                            required = false)
                    Integer intervalMinutes,
            @ToolParam(
                            name = "time_of_day",
                            description = "24-hour local time HH:mm (e.g. 09:00) when schedule_type is daily",
                            required = false)
                    String timeOfDay,
            @ToolParam(
                            name = "days_of_week",
                            description = "Optional ISO weekdays [1..7] (1=Monday, 7=Sunday) for daily mode; omit for every day",
                            required = false)
                    List<Integer> daysOfWeek,
            @ToolParam(
                            name = "delay_minutes",
                            description = "Minutes from now (1-10080) for once mode or initial delay for interval mode",
                            required = false)
                    Integer delayMinutes,
            @ToolParam(
                            name = "run_at",
                            description = "Local date-time (yyyy-MM-dd HH:mm or ISO-8601) when schedule_type is once",
                            required = false)
                    String runAt) {
        try {
            Long parsedRunAt = parseRunAt(runAt);
            validateCreatePreview(name, prompt, scheduleType, intervalMinutes, timeOfDay, daysOfWeek, delayMinutes, parsedRunAt);
            String preview = formatProposal(
                    "创建",
                    name,
                    prompt,
                    scheduleType,
                    intervalMinutes,
                    timeOfDay,
                    daysOfWeek,
                    delayMinutes,
                    parsedRunAt,
                    true);
            return approval.run(
                    "automation_create",
                    name.strip(),
                    "",
                    preview,
                    "自动任务创建未获批准。",
                    () -> {
                        try {
                            String sessionId = UUID.randomUUID().toString();
                            var created = store.create(new AutomationStore.CreateSpec(
                                    projectId,
                                    sessionId,
                                    name,
                                    prompt,
                                    scheduleType,
                                    intervalMinutes,
                                    timeOfDay,
                                    daysOfWeek,
                                    delayMinutes,
                                    parsedRunAt));
                            emitChanged("created", created);
                            ZoneId zone = ZoneId.systemDefault();
                            return ToolResultBlock.success(
                                    "已创建定时自动任务「" + created.name() + "」（ID: " + created.id() + "）。\n"
                                            + "计划：" + AutomationStore.describeSchedule(created, zone)
                                            + "；下次触发：" + AutomationStore.formatEpoch(created.nextRunAt(), zone) + "\n"
                                            + "独立会话 ID：" + created.sessionId()
                                            + "（桌面应用运行期间自动按计划触发，也可在左侧「更多工具 → 自动任务」立即运行或查看记录）。");
                        } catch (RuntimeException error) {
                            return ToolResultBlock.error(messageOf(error, "无法创建自动任务。"));
                        }
                    });
        } catch (RuntimeException error) {
            return ToolResultBlock.error(messageOf(error, "自动任务参数无效。"));
        }
    }

    @Tool(
            name = "automation_update",
            concurrencySafe = false,
            description = "Pause, resume, or update the schedule/prompt of an existing automated task in the current project after user approval.")
    public ToolResultBlock update(
            @ToolParam(name = "id", description = "Automation ID from automation_list") String id,
            @ToolParam(name = "enabled", description = "Set false to pause or true to resume", required = false)
                    Boolean enabled,
            @ToolParam(name = "name", description = "Updated task name", required = false) String name,
            @ToolParam(name = "prompt", description = "Updated task instructions", required = false) String prompt,
            @ToolParam(name = "schedule_type", description = "Updated mode: interval, daily, or once", required = false)
                    String scheduleType,
            @ToolParam(name = "interval_minutes", description = "Updated interval minutes (1-10080)", required = false)
                    Integer intervalMinutes,
            @ToolParam(name = "time_of_day", description = "Updated 24-hour local time HH:mm", required = false)
                    String timeOfDay,
            @ToolParam(name = "days_of_week", description = "Updated ISO weekdays [1..7]", required = false)
                    List<Integer> daysOfWeek,
            @ToolParam(name = "delay_minutes", description = "Minutes from now (1-10080)", required = false)
                    Integer delayMinutes,
            @ToolParam(name = "run_at", description = "Updated local date-time for once mode", required = false)
                    String runAt) {
        try {
            var existing = store.get(projectId, id);
            Long parsedRunAt = parseRunAt(runAt);
            String targetName = name != null ? name : existing.name();
            String targetPrompt = prompt != null ? prompt : existing.prompt();
            String targetType = scheduleType != null ? scheduleType : existing.scheduleType();
            Integer targetInterval = intervalMinutes != null ? intervalMinutes : existing.intervalMinutes();
            String targetTime = timeOfDay != null ? timeOfDay : existing.timeOfDay();
            List<Integer> targetDays = daysOfWeek != null ? daysOfWeek : existing.daysOfWeek();
            boolean targetEnabled = enabled != null ? enabled : existing.enabled();
            String preview = formatProposal(
                    "更新",
                    targetName,
                    targetPrompt,
                    targetType,
                    targetInterval,
                    targetTime,
                    targetDays,
                    delayMinutes,
                    parsedRunAt != null ? parsedRunAt : (existing.runAt() > 0 ? existing.runAt() : null),
                    targetEnabled);
            return approval.run(
                    "automation_update",
                    existing.name(),
                    "",
                    preview,
                    "自动任务更新未获批准。",
                    () -> {
                        try {
                            var updated = store.update(
                                    projectId,
                                    id,
                                    new AutomationStore.UpdateSpec(
                                            enabled,
                                            name,
                                            prompt,
                                            scheduleType,
                                            intervalMinutes,
                                            timeOfDay,
                                            daysOfWeek,
                                            delayMinutes,
                                            parsedRunAt));
                            emitChanged("updated", updated);
                            ZoneId zone = ZoneId.systemDefault();
                            return ToolResultBlock.success(
                                    "已更新自动任务「" + updated.name() + "」（ID: " + updated.id() + "）。\n"
                                            + "状态：" + (updated.enabled()
                                                    ? "已启用 · 下次触发 " + AutomationStore.formatEpoch(updated.nextRunAt(), zone)
                                                    : "已暂停")
                                            + "；计划：" + AutomationStore.describeSchedule(updated, zone));
                        } catch (RuntimeException error) {
                            return ToolResultBlock.error(messageOf(error, "无法更新自动任务。"));
                        }
                    });
        } catch (RuntimeException error) {
            return ToolResultBlock.error(messageOf(error, "无法准备自动任务更新。"));
        }
    }

    @Tool(
            name = "automation_delete",
            concurrencySafe = false,
            description = "Delete an existing scheduled automated task in the current project after user approval.")
    public ToolResultBlock delete(
            @ToolParam(name = "id", description = "Automation ID from automation_list") String id) {
        try {
            var existing = store.get(projectId, id);
            ZoneId zone = ZoneId.systemDefault();
            String preview = "删除自动任务：" + existing.name() + "（ID: " + existing.id() + "）\n"
                    + "原计划：" + AutomationStore.describeSchedule(existing, zone) + "\n"
                    + "任务内容：" + existing.prompt();
            return approval.run(
                    "automation_delete",
                    existing.name(),
                    "",
                    preview,
                    "自动任务删除未获批准。",
                    () -> {
                        try {
                            var removed = store.remove(projectId, id);
                            emitChanged("deleted", removed);
                            return ToolResultBlock.success(
                                    "已删除自动任务「" + removed.name() + "」（ID: " + removed.id() + "）。历史会话记录仍保留。");
                        } catch (RuntimeException error) {
                            return ToolResultBlock.error(messageOf(error, "无法删除自动任务。"));
                        }
                    });
        } catch (RuntimeException error) {
            return ToolResultBlock.error(messageOf(error, "无法准备自动任务删除。"));
        }
    }

    static String describeCallInput(String toolName, Map<String, Object> input) {
        if (input == null) return "";
        if ("automation_delete".equals(toolName)) {
            return "删除自动任务 ID: " + stringVal(input, "id");
        }
        var lines = new ArrayList<String>();
        String id = stringVal(input, "id");
        if (!id.isEmpty()) lines.add("任务 ID: " + id);
        String name = stringVal(input, "name");
        if (!name.isEmpty()) lines.add("名称: " + name);
        if (input.get("enabled") instanceof Boolean enabled) {
            lines.add("启用状态: " + (enabled ? "已启用" : "已暂停"));
        }
        String type = stringVal(input, "schedule_type");
        if (!type.isEmpty()) {
            lines.add("触发方式: " + type
                    + (input.get("interval_minutes") != null ? " · 每 " + input.get("interval_minutes") + " 分钟" : "")
                    + (!stringVal(input, "time_of_day").isEmpty() ? " · " + stringVal(input, "time_of_day") : "")
                    + (input.get("days_of_week") != null ? " · 星期 " + input.get("days_of_week") : "")
                    + (input.get("delay_minutes") != null ? " · 延迟 " + input.get("delay_minutes") + " 分钟" : "")
                    + (!stringVal(input, "run_at").isEmpty() ? " · " + stringVal(input, "run_at") : ""));
        }
        String prompt = stringVal(input, "prompt");
        if (!prompt.isEmpty()) lines.add("任务内容:\n" + prompt);
        return String.join("\n", lines);
    }

    private void emitChanged(String action, AutomationStore.Definition definition) {
        if (notifyChanged == null) return;
        var data = new LinkedHashMap<String, Object>();
        data.put("action", action);
        data.put("projectId", projectId);
        data.put("automationId", definition.id());
        data.put("sessionId", definition.sessionId());
        data.put("name", definition.name());
        notifyChanged.accept("automation-changed", data);
    }

    private static void validateCreatePreview(
            String name,
            String prompt,
            String scheduleType,
            Integer intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            Integer delayMinutes,
            Long runAt) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("自动任务名称不能为空。");
        if (name.strip().length() > 80) throw new IllegalArgumentException("自动任务名称不能超过 80 字符。");
        if (prompt == null || prompt.isBlank()) throw new IllegalArgumentException("自动任务内容不能为空。");
        if (prompt.strip().length() > 16_000) throw new IllegalArgumentException("自动任务内容不能超过 16,000 字符。");
        String type = scheduleType == null ? "" : scheduleType.strip().toLowerCase();
        if (!List.of("interval", "daily", "once").contains(type)) {
            throw new IllegalArgumentException("schedule_type 必须是 interval、daily 或 once。");
        }
        if (delayMinutes != null && (delayMinutes < 1 || delayMinutes > 10_080)) {
            throw new IllegalArgumentException("delay_minutes 必须在 1 到 10080 之间。");
        }
        if ("once".equals(type)) {
            if (runAt == null && delayMinutes == null) {
                throw new IllegalArgumentException("一次性任务请提供 delay_minutes 或 run_at。");
            }
            if (runAt != null && runAt <= System.currentTimeMillis()) {
                throw new IllegalArgumentException("run_at 必须晚于当前时间。");
            }
        } else if ("daily".equals(type)) {
            AutomationStore.nextDailyRun(System.currentTimeMillis(), timeOfDay, daysOfWeek, ZoneId.systemDefault());
        } else if (intervalMinutes != null && (intervalMinutes < 1 || intervalMinutes > 10_080)) {
            throw new IllegalArgumentException("interval_minutes 必须在 1 到 10080 之间。");
        }
    }

    private static String formatProposal(
            String verb,
            String name,
            String prompt,
            String scheduleType,
            Integer intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            Integer delayMinutes,
            Long runAt,
            boolean enabled) {
        ZoneId zone = ZoneId.systemDefault();
        String type = scheduleType == null ? "interval" : scheduleType.strip().toLowerCase();
        String scheduleText;
        if ("once".equals(type)) {
            scheduleText = runAt != null
                    ? "单次执行 · " + AutomationStore.formatEpoch(runAt, zone)
                    : "单次执行 · " + (delayMinutes == null ? 0 : delayMinutes) + " 分钟后";
        } else if ("daily".equals(type)) {
            var previewDef = new AutomationStore.Definition(
                    "", "", "", "", "", "daily", 0, timeOfDay == null ? "" : timeOfDay.strip(),
                    daysOfWeek == null ? List.of() : daysOfWeek, 0L, 0L, enabled, 0L, 0L);
            scheduleText = AutomationStore.describeSchedule(previewDef, zone);
        } else {
            int mins = intervalMinutes == null || intervalMinutes <= 0 ? 60 : intervalMinutes;
            scheduleText = "固定间隔 · 每 " + mins + " 分钟"
                    + (delayMinutes != null ? "（首次 " + delayMinutes + " 分钟后）" : "");
        }
        return verb + "自动任务：" + name.strip()
                + "\n状态：" + (enabled ? "已启用" : "已暂停")
                + "\n计划：" + scheduleText
                + "\n每次触发执行的任务内容：\n" + prompt.strip();
    }

    static Long parseRunAt(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String text = raw.strip();
        if (text.matches("^\\d{10,15}$")) {
            long value = Long.parseLong(text);
            return text.length() == 10 ? value * 1000L : value;
        }
        ZoneId zone = ZoneId.systemDefault();
        try {
            return Instant.parse(text).toEpochMilli();
        } catch (DateTimeParseException ignored) {
        }
        try {
            return OffsetDateTime.parse(text).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
        }
        try {
            return ZonedDateTime.parse(text).toInstant().toEpochMilli();
        } catch (DateTimeParseException ignored) {
        }
        for (var formatter : List.of(
                DateTimeFormatter.ISO_LOCAL_DATE_TIME,
                SPACE_DATE_TIME_SECONDS,
                SPACE_DATE_TIME)) {
            try {
                return LocalDateTime.parse(text, formatter).atZone(zone).toInstant().toEpochMilli();
            } catch (DateTimeParseException ignored) {
            }
        }
        throw new IllegalArgumentException("无法解析 run_at 时间格式，请使用 yyyy-MM-dd HH:mm 或 ISO-8601 格式。");
    }

    private static String stringVal(Map<String, Object> map, String key) {
        return map.get(key) instanceof String s ? s.strip() : "";
    }

    private static String messageOf(Throwable error, String fallback) {
        return error.getMessage() == null || error.getMessage().isBlank() ? fallback : error.getMessage();
    }
}
