package local.jharness.search;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Rebuildable SQLite FTS5 projection for cross-session message recall.
 *
 * <p>Latin words are indexed as lower-case tokens. CJK runs are indexed as adjacent bigrams,
 * which keeps phrase-like recall useful without requiring a language-specific SQLite extension.
 * The append-only session journal remains the source of truth.
 */
public final class SessionSearchIndex {
    public record Message(
            String projectId,
            String sessionId,
            String messageId,
            int turn,
            String role,
            String text) {}

    public record Match(
            String projectId,
            String sessionId,
            String messageId,
            int turn,
            String role,
            String text,
            double rank) {}

    private final Path database;
    private final Object lock = new Object();

    public SessionSearchIndex(Path database) {
        this.database = database.toAbsolutePath().normalize();
    }

    public boolean needsSync(String sessionId, long headSeq) {
        synchronized (lock) {
            try (var connection = connect()) {
                initialize(connection);
                try (var statement = connection.prepareStatement(
                        "SELECT head_seq FROM search_sessions WHERE session_id = ?")) {
                    statement.setString(1, sessionId);
                    try (var result = statement.executeQuery()) {
                        return !result.next() || result.getLong(1) != headSeq;
                    }
                }
            } catch (SQLException error) {
                throw new IllegalStateException("无法读取会话搜索索引。", error);
            }
        }
    }

    public void sync(String sessionId, long headSeq, List<Message> messages) {
        synchronized (lock) {
            try (var connection = connect()) {
                initialize(connection);
                connection.setAutoCommit(false);
                try {
                    var existing = new java.util.HashMap<String, String>();
                    try (var statement = connection.prepareStatement(
                            "SELECT message_id, content_hash FROM message_search_state WHERE session_id = ?")) {
                        statement.setString(1, sessionId);
                        try (var result = statement.executeQuery()) {
                            while (result.next())
                                existing.put(result.getString(1), result.getString(2));
                        }
                    }
                    var present = new HashSet<String>();
                    for (var message : messages) {
                        present.add(message.messageId());
                        String hash = Integer.toHexString(message.text().hashCode());
                        if (hash.equals(existing.get(message.messageId()))) continue;
                        deleteMessage(connection, sessionId, message.messageId());
                        insertMessage(connection, message, hash);
                    }
                    for (String stale : existing.keySet()) {
                        if (!present.contains(stale)) {
                            deleteMessage(connection, sessionId, stale);
                        }
                    }
                    try (var statement = connection.prepareStatement("""
                            INSERT INTO search_sessions(session_id, head_seq, updated_at)
                            VALUES(?, ?, ?)
                            ON CONFLICT(session_id) DO UPDATE SET
                              head_seq = excluded.head_seq,
                              updated_at = excluded.updated_at
                            """)) {
                        statement.setString(1, sessionId);
                        statement.setLong(2, headSeq);
                        statement.setLong(3, System.currentTimeMillis());
                        statement.executeUpdate();
                    }
                    connection.commit();
                } catch (SQLException error) {
                    connection.rollback();
                    throw error;
                } finally {
                    connection.setAutoCommit(true);
                }
            } catch (SQLException error) {
                throw new IllegalStateException("无法更新会话搜索索引。", error);
            }
        }
    }

    public List<Match> search(String query, Set<String> allowedSessions) {
        if (allowedSessions.isEmpty()) return List.of();
        String expression = queryExpression(query);
        if (expression.isBlank()) return List.of();
        synchronized (lock) {
            try (var connection = connect()) {
                initialize(connection);
                try (var statement = connection.prepareStatement("""
                        SELECT project_id, session_id, message_id, turn, role, text, bm25(message_search)
                        FROM message_search
                        WHERE message_search MATCH ?
                        ORDER BY bm25(message_search), session_id, turn
                        LIMIT 500
                        """)) {
                    statement.setString(1, expression);
                    var matches = new ArrayList<Match>();
                    try (var result = statement.executeQuery()) {
                        while (result.next() && matches.size() < 100) {
                            String sessionId = result.getString(2);
                            if (!allowedSessions.contains(sessionId)) continue;
                            matches.add(new Match(
                                    result.getString(1),
                                    sessionId,
                                    result.getString(3),
                                    result.getInt(4),
                                    result.getString(5),
                                    result.getString(6),
                                    result.getDouble(7)));
                        }
                    }
                    return List.copyOf(matches);
                }
            } catch (SQLException error) {
                throw new IllegalStateException("无法搜索会话索引。", error);
            }
        }
    }

    public static List<String> tokens(String text) {
        var result = new LinkedHashSet<String>();
        var latin = new StringBuilder();
        var cjk = new StringBuilder();
        for (int offset = 0; offset < text.length(); ) {
            int code = text.codePointAt(offset);
            offset += Character.charCount(code);
            if (isLatin(code)) {
                flushCjk(cjk, result);
                latin.appendCodePoint(Character.toLowerCase(code));
            } else if (isCjk(code)) {
                flushLatin(latin, result);
                cjk.appendCodePoint(code);
            } else {
                flushLatin(latin, result);
                flushCjk(cjk, result);
            }
        }
        flushLatin(latin, result);
        flushCjk(cjk, result);
        return List.copyOf(result);
    }

    private static String queryExpression(String query) {
        var tokens = tokens(query.strip());
        if (tokens.isEmpty()) return "";
        return String.join(" AND ", tokens.stream().map(token -> token.replace("\"", "")).toList());
    }

    private static void flushLatin(StringBuilder value, Set<String> tokens) {
        if (value.isEmpty()) return;
        tokens.add("w_" + value);
        value.setLength(0);
    }

    private static void flushCjk(StringBuilder value, Set<String> tokens) {
        if (value.isEmpty()) return;
        int[] points = value.codePoints().toArray();
        if (points.length == 1) tokens.add("c_" + new String(points, 0, 1));
        else {
            for (int i = 0; i + 1 < points.length; i++)
                tokens.add("c_" + new String(points, i, 2));
        }
        value.setLength(0);
    }

    private static boolean isLatin(int code) {
        return Character.isLetterOrDigit(code) && code < 0x2E80;
    }

    private static boolean isCjk(int code) {
        return (code >= 0x3400 && code <= 0x4DBF)
                || (code >= 0x4E00 && code <= 0x9FFF)
                || (code >= 0xF900 && code <= 0xFAFF)
                || (code >= 0x3040 && code <= 0x30FF)
                || (code >= 0xAC00 && code <= 0xD7AF);
    }

    private void insertMessage(Connection connection, Message message, String hash)
            throws SQLException {
        try (var statement = connection.prepareStatement(
                "INSERT INTO message_search(project_id, session_id, message_id, turn, role, text, tokens) "
                        + "VALUES(?, ?, ?, ?, ?, ?, ?)")) {
            statement.setString(1, message.projectId());
            statement.setString(2, message.sessionId());
            statement.setString(3, message.messageId());
            statement.setInt(4, message.turn());
            statement.setString(5, message.role());
            statement.setString(6, message.text());
            statement.setString(7, String.join(" ", tokens(message.text())));
            statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement(
                "INSERT INTO message_search_state(session_id, message_id, content_hash) VALUES(?, ?, ?)")) {
            statement.setString(1, message.sessionId());
            statement.setString(2, message.messageId());
            statement.setString(3, hash);
            statement.executeUpdate();
        }
    }

    private void deleteMessage(Connection connection, String sessionId, String messageId)
            throws SQLException {
        try (var statement = connection.prepareStatement(
                "DELETE FROM message_search WHERE session_id = ? AND message_id = ?")) {
            statement.setString(1, sessionId);
            statement.setString(2, messageId);
            statement.executeUpdate();
        }
        try (var statement = connection.prepareStatement(
                "DELETE FROM message_search_state WHERE session_id = ? AND message_id = ?")) {
            statement.setString(1, sessionId);
            statement.setString(2, messageId);
            statement.executeUpdate();
        }
    }

    private Connection connect() throws SQLException {
        try {
            Files.createDirectories(database.getParent());
        } catch (java.io.IOException error) {
            throw new IllegalStateException("无法创建搜索索引目录。", error);
        }
        var connection = DriverManager.getConnection("jdbc:sqlite:" + database);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("PRAGMA synchronous=NORMAL");
        }
        return connection;
    }

    private static void initialize(Connection connection) throws SQLException {
        try (var statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS search_sessions(
                      session_id TEXT PRIMARY KEY,
                      head_seq INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL
                    )
                    """);
            statement.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
                      project_id UNINDEXED,
                      session_id UNINDEXED,
                      message_id UNINDEXED,
                      turn UNINDEXED,
                      role UNINDEXED,
                      text UNINDEXED,
                      tokens,
                      tokenize='unicode61'
                    )
                    """);
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS message_search_state(
                      session_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      content_hash TEXT NOT NULL,
                      PRIMARY KEY(session_id, message_id)
                    )
                    """);
        }
    }
}
