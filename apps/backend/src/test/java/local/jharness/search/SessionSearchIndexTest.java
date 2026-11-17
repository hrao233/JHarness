package local.jharness.search;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SessionSearchIndexTest {
    @TempDir Path temporary;

    @Test
    void indexesLatinWordsAndCjkBigramsAndSkipsUnchangedSessions() {
        var index = new SessionSearchIndex(temporary.resolve("search.sqlite"));
        String sessionId = UUID.randomUUID().toString();
        var messages = List.of(
                message(sessionId, "m1", 1, "请修复认证模块的中文错误"),
                message(sessionId, "m2", 2, "Fix browser search in Edge"),
                message(sessionId, "m3", 3, "Attachment fixture.png"));

        assertTrue(index.needsSync(sessionId, 10));
        index.sync(sessionId, 10, messages);
        assertFalse(index.needsSync(sessionId, 10));

        assertEquals("m1", index.search("认证模块", Set.of(sessionId)).get(0).messageId());
        assertEquals("m2", index.search("browser search", Set.of(sessionId)).get(0).messageId());
        assertEquals("m3", index.search("fixture.png", Set.of(sessionId)).get(0).messageId());
        assertEquals(
                List.of("c_认证", "c_证模", "c_模块"),
                SessionSearchIndex.tokens("认证模块"));
    }

    @Test
    void searchesFiveThousandMessagesWithinTheLocalBudget() {
        var index = new SessionSearchIndex(temporary.resolve("long-search.sqlite"));
        String sessionId = UUID.randomUUID().toString();
        var messages = new ArrayList<SessionSearchIndex.Message>();
        for (int i = 0; i < 5000; i++) {
            messages.add(message(
                    sessionId,
                    "long-" + i,
                    i / 2 + 1,
                    "message " + i + (i == 4321 ? " NEEDLE-4321" : " routine project text")));
        }
        index.sync(sessionId, 5000, messages);

        long started = System.nanoTime();
        var result = index.search("needle-4321", Set.of(sessionId));
        long elapsed = Duration.ofNanos(System.nanoTime() - started).toMillis();

        assertEquals("long-4321", result.get(0).messageId());
        assertTrue(elapsed < 2000, "5k-message FTS query took " + elapsed + "ms");

        started = System.nanoTime();
        var common = index.search("routine project text", Set.of(sessionId));
        elapsed = Duration.ofNanos(System.nanoTime() - started).toMillis();

        assertEquals(100, common.size());
        assertTrue(elapsed < 2000, "Common query across 5k messages took " + elapsed + "ms");
    }

    @Test
    void ranksBilingualConversationRecallAgainstJudgedResults() {
        var index = new SessionSearchIndex(temporary.resolve("bilingual-search.sqlite"));
        String development = "development";
        String operations = "operations";
        String support = "support";
        index.sync(development, 14, List.of(
                message(development, "recovery-guide", 1,
                        "会话恢复时先核对未知的工具结果，确认副作用后再续跑原任务，重启不会重复修改文件。"),
                message(development, "recovery-test", 2,
                        "补了会话恢复回归测试，覆盖工具已派发但结果未写入的中断路径。"),
                message(development, "webview-start", 3,
                        "WebView2 初始化失败时显示可操作的提示，并保留窗口的本地日志用于诊断。"),
                message(development, "webview-log", 4,
                        "WebView2初始化日志落在桌面应用的数据目录。"),
                message(development, "filename", 5,
                        "The acceptance verifier can read task-report.json from the staging folder."),
                message(development, "backend-filename", 6,
                        "任务报告使用 task-report.json 保存验收项和命令证据。"),
                message(development, "index-source", 7,
                        "SessionSearchIndex projects message IDs from the append-only session log.")));
        index.sync(operations, 10, List.of(
                message(operations, "powershell-policy", 1,
                        "PowerShell 重试间隔使用指数退避，最多三次。每次尝试保留单独的退出码。"),
                message(operations, "sqlite-wal", 2,
                        "SQLite WAL 保留在同一目录，复制备份时应从一致的快照导出。"),
                message(operations, "sqlite-backup", 3,
                        "The SQLite backup can finish while WAL mode is active."),
                message(operations, "cleanup-guide", 4,
                        "The worktree panel runs branch cleanup after confirming unpublished changes."),
                message(operations, "exit-status", 5,
                        "Exit code 137 usually means the process was killed. Check the runner memory log.")));
        index.sync(support, 12, List.of(
                message(support, "phone", 1, "查看会话表后转到电话恢复方案。"),
                message(support, "powershell-install", 2, "重试安装 PowerShell。"),
                message(support, "separate-words", 3, "JSON report task"),
                message(support, "spelling", 4, "Cleanup branch"),
                message(support, "ticket-number", 5, "137 code reviewed"),
                message(support, "wal-unrelated", 6, "WAL mode SQLite")));

        var queries = List.of(
                new RecallCase("会话恢复", "recovery-test", Set.of("recovery-guide", "recovery-test")),
                new RecallCase("PowerShell 重试", "powershell-policy", Set.of("powershell-policy")),
                new RecallCase("WebView2 初始化", "webview-start", Set.of("webview-start", "webview-log")),
                new RecallCase("task-report.json", "filename", Set.of("filename", "backend-filename")),
                new RecallCase("SessionSearchIndex", "index-source", Set.of("index-source")),
                new RecallCase("SQLite WAL", "sqlite-wal", Set.of("sqlite-wal", "sqlite-backup")),
                new RecallCase("branch cleanup", "cleanup-guide", Set.of("cleanup-guide")),
                new RecallCase("code 137", "exit-status", Set.of("exit-status")));

        double reciprocalRank = 0;
        double recall = 0;
        var misses = new ArrayList<String>();
        for (var query : queries) {
            var firstThree = index.search(query.text(), Set.of(development, operations, support))
                    .stream().limit(3).map(SessionSearchIndex.Match::messageId).toList();
            int firstRelevant = 0;
            int relevant = 0;
            for (int i = 0; i < firstThree.size(); i++) {
                if (query.relevant().contains(firstThree.get(i))) {
                    relevant++;
                    if (firstRelevant == 0) firstRelevant = i + 1;
                }
            }
            reciprocalRank += firstRelevant == 0 ? 0 : 1d / firstRelevant;
            recall += (double) relevant / query.relevant().size();
            if (!firstThree.contains(query.expected()) || firstRelevant != 1) {
                misses.add(query.text() + " → " + firstThree);
            }
        }
        double mrr = reciprocalRank / queries.size();
        double recallAtThree = recall / queries.size();
        assertTrue(misses.isEmpty() && mrr >= 0.95 && recallAtThree >= 0.95,
                "M3 recall corpus MRR@3=" + mrr + ", Recall@3=" + recallAtThree + ", misses=" + misses);
        assertTrue(index.search("无关词条 zzz", Set.of(development, operations, support)).isEmpty());
    }

    @Test
    void excludedSessionsCannotCrowdOutAnEligibleMatch() {
        var index = new SessionSearchIndex(temporary.resolve("scoped-search.sqlite"));
        String excluded = "removed-session";
        String allowed = "visible-session";
        var messages = new ArrayList<SessionSearchIndex.Message>();
        for (int i = 0; i < 510; i++) {
            messages.add(message(excluded, "removed-" + i, i, "WAL checkpoint"));
        }
        index.sync(excluded, 510, messages);
        index.sync(allowed, 1, List.of(message(allowed, "kept", 1,
                "The WAL checkpoint cleared the maintenance queue after the database backup.")));

        assertEquals(List.of("kept"), index.search("WAL checkpoint", Set.of(allowed))
                .stream().map(SessionSearchIndex.Match::messageId).toList());
        assertEquals(100, index.search("WAL checkpoint", Set.of(excluded, allowed)).size());
    }

    private record RecallCase(String text, String expected, Set<String> relevant) {}

    private static SessionSearchIndex.Message message(
            String sessionId, String id, int turn, String text) {
        return new SessionSearchIndex.Message(
                "project", sessionId, id, turn, turn % 2 == 0 ? "assistant" : "user", text);
    }
}
