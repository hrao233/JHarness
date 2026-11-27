package local.jharness.agent;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.regex.Pattern;

/**
 * Persistent local automation store shared with the Electron desktop scheduler.
 *
 * <p>Uses the desktop's SQLite lock file ({@code settings-lock.sqlite}) so updates from the Java
 * agent and claims from the Electron timer serialize safely across processes.
 */
public final class AutomationStore {
    private static final int MAX_NAME = 80;
    private static final int MAX_PROMPT = 16_000;
    private static final int MIN_INTERVAL_MINUTES = 1;
    private static final int MAX_INTERVAL_MINUTES = 10_080;
    private static final Set<String> ACTIVE_STATUSES = Set.of("queued", "running", "suspended");
    private static final Pattern TIME_OF_DAY = Pattern.compile("^(?:[01]\\d|2[0-3]):[0-5]\\d$");

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Definition(
            String id,
            String name,
            String prompt,
            String projectId,
            String sessionId,
            String scheduleType,
            int intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            long runAt,
            long nextRunAt,
            boolean enabled,
            long createdAt,
            long updatedAt) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RunRecord(
            String id,
            String automationId,
            String automationName,
            String projectId,
            String sessionId,
            String trigger,
            long scheduledFor,
            String status,
            String runId,
            long startedAt,
            long finishedAt,
            String error) {}

    public record CreateSpec(
            String projectId,
            String sessionId,
            String name,
            String prompt,
            String scheduleType,
            Integer intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            Integer delayMinutes,
            Long runAt) {}

    public record UpdateSpec(
            Boolean enabled,
            String name,
            String prompt,
            String scheduleType,
            Integer intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            Integer delayMinutes,
            Long runAt) {}

    public record Snapshot(List<Definition> definitions, List<RunRecord> runs) {}

    private final Path file;
    private final Path lockFile;
    private final Object mutex = new Object();
    private final ObjectMapper json = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    public AutomationStore(Path file) {
        this.file = file.toAbsolutePath().normalize();
        Path parent = this.file.getParent();
        this.lockFile = (parent == null ? Path.of(".") : parent).resolve("settings-lock.sqlite");
    }

    public static Path resolveDefaultFile(Path backendDataDirectory) {
        Path normalized = backendDataDirectory.toAbsolutePath().normalize();
        Path name = normalized.getFileName();
        if (name != null && "workspaces".equalsIgnoreCase(name.toString()) && normalized.getParent() != null) {
            return normalized.getParent().resolve("automations.json");
        }
        return normalized.resolve("automations.json");
    }

    public Snapshot list(String projectId) {
        return withLock(() -> {
            ObjectNode root = readRoot();
            var definitions = new ArrayList<Definition>();
            for (JsonNode node : root.withArray("definitions")) {
                Definition item = toDefinition(node);
                if (projectId == null || projectId.isBlank() || projectId.equals(item.projectId())) {
                    definitions.add(item);
                }
            }
            var runs = new ArrayList<RunRecord>();
            for (JsonNode node : root.withArray("runs")) {
                RunRecord run = json.treeToValue(node, RunRecord.class);
                if (projectId == null || projectId.isBlank() || projectId.equals(run.projectId())) {
                    runs.add(run);
                    if (runs.size() >= 100) break;
                }
            }
            return new Snapshot(List.copyOf(definitions), List.copyOf(runs));
        });
    }

    public Definition get(String projectId, String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("请提供自动任务 ID。");
        return list(projectId).definitions().stream()
                .filter(item -> id.equals(item.id()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("当前项目中找不到该自动任务。"));
    }

    public Definition create(CreateSpec spec) {
        return withLock(() -> {
            ObjectNode root = readRoot();
            long now = System.currentTimeMillis();
            String projectId = String.valueOf(spec.projectId() == null ? "" : spec.projectId()).strip();
            String sessionId = String.valueOf(spec.sessionId() == null ? "" : spec.sessionId()).strip();
            if (projectId.isEmpty() || sessionId.isEmpty()) {
                throw new IllegalArgumentException("自动任务缺少项目或会话。");
            }
            String name = validateName(spec.name());
            String prompt = validatePrompt(spec.prompt());
            Schedule schedule = resolveSchedule(
                    now,
                    spec.scheduleType(),
                    spec.intervalMinutes(),
                    spec.timeOfDay(),
                    spec.daysOfWeek(),
                    spec.delayMinutes(),
                    spec.runAt());
            var definition = new Definition(
                    UUID.randomUUID().toString(),
                    name,
                    prompt,
                    projectId,
                    sessionId,
                    schedule.type(),
                    schedule.intervalMinutes(),
                    schedule.timeOfDay(),
                    schedule.daysOfWeek(),
                    schedule.runAt(),
                    schedule.nextRunAt(),
                    true,
                    now,
                    now);
            ArrayNode definitions = root.withArray("definitions");
            var updated = json.createArrayNode();
            updated.add(json.valueToTree(definition));
            definitions.forEach(updated::add);
            root.set("definitions", updated);
            writeRoot(root);
            return definition;
        });
    }

    public Definition update(String projectId, String id, UpdateSpec patch) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("请提供自动任务 ID。");
        return withLock(() -> {
            ObjectNode root = readRoot();
            ArrayNode definitions = root.withArray("definitions");
            int index = findDefinitionIndex(definitions, projectId, id);
            if (index < 0) throw new IllegalArgumentException("当前项目中找不到该自动任务。");
            Definition existing = toDefinition(definitions.get(index));
            long now = System.currentTimeMillis();
            String name = patch.name() != null ? validateName(patch.name()) : existing.name();
            String prompt = patch.prompt() != null ? validatePrompt(patch.prompt()) : existing.prompt();
            boolean enabled = patch.enabled() != null ? patch.enabled() : existing.enabled();

            boolean scheduleEdited = patch.scheduleType() != null
                    || patch.intervalMinutes() != null
                    || patch.timeOfDay() != null
                    || patch.daysOfWeek() != null
                    || patch.delayMinutes() != null
                    || patch.runAt() != null;

            String type = existing.scheduleType();
            int intervalMinutes = existing.intervalMinutes();
            String timeOfDay = existing.timeOfDay();
            List<Integer> daysOfWeek = existing.daysOfWeek();
            long runAt = existing.runAt();
            long nextRunAt = existing.nextRunAt();

            if (scheduleEdited) {
                String targetType = patch.scheduleType() != null ? patch.scheduleType() : existing.scheduleType();
                Schedule schedule = resolveSchedule(
                        now,
                        targetType,
                        patch.intervalMinutes() != null ? patch.intervalMinutes() : existing.intervalMinutes(),
                        patch.timeOfDay() != null ? patch.timeOfDay() : existing.timeOfDay(),
                        patch.daysOfWeek() != null ? patch.daysOfWeek() : existing.daysOfWeek(),
                        patch.delayMinutes(),
                        patch.runAt() != null ? patch.runAt() : (existing.runAt() > now ? existing.runAt() : null));
                type = schedule.type();
                intervalMinutes = schedule.intervalMinutes();
                timeOfDay = schedule.timeOfDay();
                daysOfWeek = schedule.daysOfWeek();
                runAt = schedule.runAt();
                nextRunAt = enabled ? schedule.nextRunAt() : 0L;
            } else if (patch.enabled() != null) {
                if (enabled) {
                    nextRunAt = computeNextWhenEnabled(now, type, intervalMinutes, timeOfDay, daysOfWeek, runAt);
                }
            }

            var updated = new Definition(
                    existing.id(),
                    name,
                    prompt,
                    existing.projectId(),
                    existing.sessionId(),
                    type,
                    intervalMinutes,
                    timeOfDay,
                    daysOfWeek,
                    runAt,
                    nextRunAt,
                    enabled,
                    existing.createdAt(),
                    now);
            definitions.set(index, json.valueToTree(updated));
            writeRoot(root);
            return updated;
        });
    }

    public Definition remove(String projectId, String id) {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("请提供自动任务 ID。");
        return withLock(() -> {
            ObjectNode root = readRoot();
            ArrayNode definitions = root.withArray("definitions");
            int index = findDefinitionIndex(definitions, projectId, id);
            if (index < 0) throw new IllegalArgumentException("当前项目中找不到该自动任务。");
            for (JsonNode run : root.withArray("runs")) {
                if (id.equals(run.path("automationId").asText())
                        && ACTIVE_STATUSES.contains(run.path("status").asText())) {
                    throw new IllegalStateException("自动任务仍有活动运行，请先等待完成或在自动任务面板取消。");
                }
            }
            Definition removed = toDefinition(definitions.get(index));
            definitions.remove(index);
            writeRoot(root);
            return removed;
        });
    }

    public static long nextDailyRun(long fromMs, String timeOfDay, List<Integer> daysOfWeek, ZoneId zone) {
        LocalTime localTime = parseTimeOfDay(timeOfDay);
        List<Integer> allowedDays = normalizeDaysOfWeek(daysOfWeek);
        ZonedDateTime reference = Instant.ofEpochMilli(fromMs).atZone(zone);
        LocalDate startDate = reference.toLocalDate();
        for (int offset = 0; offset <= 7; offset++) {
            LocalDate date = startDate.plusDays(offset);
            int isoDay = date.getDayOfWeek().getValue();
            if (!allowedDays.isEmpty() && !allowedDays.contains(isoDay)) continue;
            long candidate = ZonedDateTime.of(date, localTime, zone).toInstant().toEpochMilli();
            if (candidate > fromMs) return candidate;
        }
        throw new IllegalArgumentException("无法计算下一次每日定时执行时间。");
    }

    public static String describeSchedule(Definition definition, ZoneId zone) {
        if ("once".equals(definition.scheduleType())) {
            long target = definition.runAt() > 0 ? definition.runAt() : definition.nextRunAt();
            return "单次执行（" + formatEpoch(target, zone) + "）";
        }
        if ("daily".equals(definition.scheduleType())) {
            String days = formatDaysOfWeek(definition.daysOfWeek());
            return days + " " + definition.timeOfDay();
        }
        return "每 " + definition.intervalMinutes() + " 分钟";
    }

    static String formatEpoch(long epochMs, ZoneId zone) {
        if (epochMs <= 0) return "未计划";
        var dt = Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDateTime().withNano(0);
        return String.format(
                "%04d-%02d-%02d %02d:%02d:%02d",
                dt.getYear(), dt.getMonthValue(), dt.getDayOfMonth(),
                dt.getHour(), dt.getMinute(), dt.getSecond());
    }

    private static String formatDaysOfWeek(List<Integer> days) {
        if (days == null || days.isEmpty() || days.size() == 7) return "每天";
        String[] names = {"", "周一", "周二", "周三", "周四", "周五", "周六", "周日"};
        var labels = days.stream().filter(d -> d >= 1 && d <= 7).distinct().sorted().map(d -> names[d]).toList();
        return labels.isEmpty() ? "每天" : "每" + String.join("、", labels);
    }

    private record Schedule(
            String type,
            int intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            long runAt,
            long nextRunAt) {}

    private static Schedule resolveSchedule(
            long now,
            String rawType,
            Integer rawInterval,
            String rawTimeOfDay,
            List<Integer> rawDaysOfWeek,
            Integer delayMinutes,
            Long rawRunAt) {
        String type = rawType == null ? "interval" : rawType.strip().toLowerCase();
        if (!Set.of("interval", "daily", "once").contains(type)) {
            throw new IllegalArgumentException("schedule_type 必须是 interval、daily 或 once。");
        }
        if (delayMinutes != null && (delayMinutes < 1 || delayMinutes > MAX_INTERVAL_MINUTES)) {
            throw new IllegalArgumentException("delay_minutes 必须在 1 到 10080 之间。");
        }
        if ("once".equals(type)) {
            long runAt = rawRunAt != null
                    ? rawRunAt
                    : delayMinutes != null ? now + delayMinutes * 60_000L : 0L;
            if (runAt <= now) {
                throw new IllegalArgumentException("一次性任务的执行时间必须晚于当前时间（可指定 run_at 或 delay_minutes）。");
            }
            return new Schedule("once", 0, "", List.of(), runAt, runAt);
        }
        if ("daily".equals(type)) {
            parseTimeOfDay(rawTimeOfDay);
            String time = rawTimeOfDay.strip();
            List<Integer> days = normalizeDaysOfWeek(rawDaysOfWeek);
            long next = nextDailyRun(now, time, days, ZoneId.systemDefault());
            return new Schedule("daily", 0, time, days, 0L, next);
        }
        int interval = Math.max(
                MIN_INTERVAL_MINUTES,
                Math.min(rawInterval == null || rawInterval <= 0 ? 60 : rawInterval, MAX_INTERVAL_MINUTES));
        long initialDelay = (delayMinutes != null ? delayMinutes : interval) * 60_000L;
        return new Schedule("interval", interval, "", List.of(), 0L, now + initialDelay);
    }

    private static long computeNextWhenEnabled(
            long now,
            String type,
            int intervalMinutes,
            String timeOfDay,
            List<Integer> daysOfWeek,
            long runAt) {
        if ("once".equals(type)) return Math.max(now + 1000L, runAt);
        if ("daily".equals(type)) return nextDailyRun(now, timeOfDay, daysOfWeek, ZoneId.systemDefault());
        int interval = Math.max(MIN_INTERVAL_MINUTES, Math.min(intervalMinutes <= 0 ? 60 : intervalMinutes, MAX_INTERVAL_MINUTES));
        return now + interval * 60_000L;
    }

    private static LocalTime parseTimeOfDay(String raw) {
        String text = raw == null ? "" : raw.strip();
        if (!TIME_OF_DAY.matcher(text).matches()) {
            throw new IllegalArgumentException("time_of_day 格式必须为 24 小时制 HH:mm（例如 09:00）。");
        }
        int hour = Integer.parseInt(text.substring(0, 2));
        int minute = Integer.parseInt(text.substring(3, 5));
        return LocalTime.of(hour, minute);
    }

    private static List<Integer> normalizeDaysOfWeek(List<Integer> raw) {
        if (raw == null || raw.isEmpty()) return List.of();
        var sorted = new ArrayList<Integer>();
        for (Integer day : raw) {
            if (day == null || day < 1 || day > 7) {
                throw new IllegalArgumentException("days_of_week 中的星期必须为 1（周一）至 7（周日）。");
            }
            if (!sorted.contains(day)) sorted.add(day);
        }
        sorted.sort(Integer::compareTo);
        return sorted.size() == 7 ? List.of() : List.copyOf(sorted);
    }

    private static String validateName(String raw) {
        String name = raw == null ? "" : raw.strip();
        if (name.isEmpty()) throw new IllegalArgumentException("自动任务名称不能为空。");
        if (name.length() > MAX_NAME) throw new IllegalArgumentException("自动任务名称不能超过 80 字符。");
        return name;
    }

    private static String validatePrompt(String raw) {
        String prompt = raw == null ? "" : raw.strip();
        if (prompt.isEmpty()) throw new IllegalArgumentException("自动任务内容不能为空。");
        if (prompt.length() > MAX_PROMPT) throw new IllegalArgumentException("自动任务内容不能超过 16,000 字符。");
        return prompt;
    }

    private Definition toDefinition(JsonNode node) throws IOException {
        Definition parsed = json.treeToValue(node, Definition.class);
        return new Definition(
                parsed.id(),
                parsed.name(),
                parsed.prompt(),
                parsed.projectId(),
                parsed.sessionId(),
                parsed.scheduleType() == null || parsed.scheduleType().isBlank() ? "interval" : parsed.scheduleType(),
                parsed.intervalMinutes(),
                parsed.timeOfDay() == null ? "" : parsed.timeOfDay(),
                parsed.daysOfWeek() == null ? List.of() : List.copyOf(parsed.daysOfWeek()),
                parsed.runAt(),
                parsed.nextRunAt(),
                parsed.enabled(),
                parsed.createdAt(),
                parsed.updatedAt());
    }

    private static int findDefinitionIndex(ArrayNode definitions, String projectId, String id) {
        for (int i = 0; i < definitions.size(); i++) {
            JsonNode item = definitions.get(i);
            if (id.equals(item.path("id").asText())
                    && (projectId == null || projectId.isBlank() || projectId.equals(item.path("projectId").asText()))) {
                return i;
            }
        }
        return -1;
    }

    private ObjectNode readRoot() throws IOException {
        if (!Files.exists(file)) {
            ObjectNode empty = json.createObjectNode();
            empty.put("version", 1);
            empty.putArray("definitions");
            empty.putArray("runs");
            return empty;
        }
        JsonNode parsed = json.readTree(Files.readString(file, StandardCharsets.UTF_8));
        if (!(parsed instanceof ObjectNode root)
                || root.path("version").asInt() != 1
                || !root.path("definitions").isArray()
                || !root.path("runs").isArray()) {
            throw new IllegalStateException("自动任务数据格式无效。");
        }
        return root;
    }

    private void writeRoot(ObjectNode root) throws IOException {
        Path parent = file.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path temporary = file.resolveSibling(file.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            Files.writeString(temporary, json.writeValueAsString(root) + "\n", StandardCharsets.UTF_8);
            Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private <T> T withLock(Callable<T> action) {
        synchronized (mutex) {
            try {
                Path parent = lockFile.getParent();
                if (parent != null) Files.createDirectories(parent);
                try (var connection = DriverManager.getConnection("jdbc:sqlite:" + lockFile);
                        var statement = connection.createStatement()) {
                    statement.execute("PRAGMA busy_timeout=5000");
                    statement.execute("BEGIN IMMEDIATE");
                    try {
                        T result = action.call();
                        statement.execute("COMMIT");
                        return result;
                    } catch (Exception error) {
                        try {
                            statement.execute("ROLLBACK");
                        } catch (SQLException ignored) {
                            // Connection close will roll back uncommitted transactions.
                        }
                        throw error;
                    }
                }
            } catch (RuntimeException error) {
                throw error;
            } catch (Exception error) {
                throw new IllegalStateException("无法读写自动任务数据：" + error.getMessage(), error);
            }
        }
    }
}
