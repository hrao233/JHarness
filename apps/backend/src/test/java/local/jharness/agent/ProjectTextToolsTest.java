package local.jharness.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.ToolResultBlock;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProjectTextToolsTest {
    @TempDir Path project;

    private static String output(ToolResultBlock result) {
        assertEquals("SUCCESS", result.getState().name());
        return ((TextBlock) result.getOutput().get(0)).getText();
    }

    @Test
    void smallFilesKeepExactTextAndCanAlsoBePaged() throws Exception {
        var tools = new ProjectTools(project, null);
        String source = "一\r\n\r\n三\n";
        Files.writeString(project.resolve("notes.txt"), source);
        assertEquals(source, output(tools.read("notes.txt", null, null)));
        assertEquals("2 | \n[下一段 start_line=3]", output(tools.read("notes.txt", 2, 1)));
        assertEquals("3 | 三\n[文件结束]", output(tools.read("notes.txt", 3, 1)));
        assertTrue(output(tools.read("notes.txt", 4, 1)).contains("无内容"));
        assertEquals("ERROR", tools.read("notes.txt", 0, 1).getState().name());
        assertEquals("ERROR", tools.read("notes.txt", 1, 401).getState().name());
        assertEquals("ERROR", tools.read("../notes.txt", 1, 1).getState().name());
    }

    @Test
    void searchAndReadUseTheSameLineNumbersInLargeFiles() throws Exception {
        var tools = new ProjectTools(project, null);
        String source = "public class Example {}\r\n".repeat(4000) + "中文标记\u2028RETURN value;";
        Files.writeString(project.resolve("Large.java"), source);
        assertTrue(output(tools.read("Large.java", null, null)).endsWith("[下一段 start_line=121]"));
        assertTrue(output(tools.searchText("return VALUE", null)).contains("Large.java:4002 RETURN value;"));
        assertEquals("4001 | 中文标记\n4002 | RETURN value;\n[文件结束]", output(tools.read("Large.java", 4001, 2)));
    }

    @Test
    void pageBudgetContinuesAtTheFirstOmittedLineAndMarksOversizedLines() throws Exception {
        var tools = new ProjectTools(project, null);
        Files.writeString(project.resolve("lines.txt"), "header\n" + "x".repeat(17000) + "\nlast");
        assertEquals("1 | header\n[下一段 start_line=2]", output(tools.read("lines.txt", 1, 10)));
        String longLine = output(tools.read("lines.txt", 2, 10));
        assertTrue(longLine.contains("本行过长，已截断"));
        assertTrue(longLine.endsWith("[下一段 start_line=3]"));
        assertEquals("3 | last\n[文件结束]", output(tools.read("lines.txt", 3, 10)));
    }

    @Test
    void searchReportsSkippedInputsAndTraversalLimits() throws Exception {
        var tools = new ProjectTools(project, null);
        Files.write(project.resolve("invalid"), new byte[]{(byte) 0xff});
        Files.write(project.resolve("binary"), new byte[]{'a', 0, 'b'});
        try (var large = new RandomAccessFile(project.resolve("oversize").toFile(), "rw")) {
            large.setLength(8 * 1024 * 1024 + 1);
        }
        Files.createDirectories(project.resolve("target"));
        Files.writeString(project.resolve("target/ignored.txt"), "needle");
        Files.createDirectories(project.resolve("d/".repeat(33)));
        Files.writeString(project.resolve("plain.txt"), "ok");
        String summary = output(tools.searchText("needle", "."));
        assertTrue(summary.contains("已扫描范围内未找到匹配"));
        assertTrue(summary.contains("已扫描 1 个文本文件；跳过 3 项"));
        assertTrue(summary.contains("超出 8 MiB 1 个，非文本或无法访问 2 项"));
        assertTrue(summary.contains("1 个目录触及深度上限"));
        Files.writeString(project.resolve("plain.txt"), "needle\n".repeat(45));
        String matches = output(tools.searchText("needle", "plain.txt"));
        assertTrue(matches.contains("plain.txt:40 "));
        assertFalse(matches.contains("plain.txt:41 "));
        assertTrue(matches.contains("最多显示 40 条"));
    }
}
