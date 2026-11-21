package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public final class ProjectTools {
    private static final int MAX_FILE_BYTES = 64 * 1024;
    private static final int MAX_READ_BYTES = 8 * 1024 * 1024;
    private static final int PAGE_CHARS = 16_000;
    private static final int SEARCH_DEPTH = 32;
    private static final int SEARCH_FILES = 3000;
    private static final int SEARCH_MATCHES = 40;
    private static final long SEARCH_BYTES = 64L * 1024 * 1024;
    private static final String EDIT_FAILURE = "无法编辑此文件。请检查项目路径、UTF-8 编码和 64 KiB 大小限制。";
    private static final String CREATE_FAILURE = "无法创建文件。请确认父目录存在、文件名未被占用，且内容不超过 64 KiB。";
    private final Path root;
    private final ApprovedOperation approval;

    ProjectTools(Path root, ApprovedOperation approval) throws IOException {
        this.root = root.toRealPath();
        this.approval = approval;
        if (!Files.isDirectory(this.root)) {
            throw new IOException("请选择有效的项目文件夹。");
        }
    }

    @Tool(name = "list_files", readOnly = true, description = "List entries in a directory inside the selected project.")
    public ToolResultBlock list(@ToolParam(name = "path", description = "Project-relative directory; use . for the root") String path) {
        try (Stream<Path> files = Files.list(resolve(path))) {
            return ToolResultBlock.success(String.join("\n", files.filter(this::visible)
                    .limit(200).map(file -> file.getFileName() + (Files.isDirectory(file) ? "/" : ""))
                    .sorted().toList()));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error("无法列出此目录。");
        }
    }

    @Tool(name = "read_file", readOnly = true, description = "Read UTF-8 project text. Large files return numbered pages; continue at the indicated start_line.")
    public ToolResultBlock read(
            @ToolParam(name = "path", description = "Project-relative file path") String path,
            @ToolParam(name = "start_line", description = "First line, numbered from 1", required = false) Integer start,
            @ToolParam(name = "line_count", description = "Number of lines (1–400, default 120 in paged mode)", required = false) Integer count) {
        if ((start != null && start < 1) || (count != null && (count < 1 || count > 400))) {
            return ToolResultBlock.error("start_line 须大于零，line_count 须在 1 至 400 之间。");
        }
        try {
            Path file = resolve(path);
            long size = Files.size(file);
            if (size > MAX_READ_BYTES) return ToolResultBlock.error("文件超过单文件读取上限 8 MiB。");
            String text = readUtf8(file, size);
            if (start == null && count == null && size <= MAX_FILE_BYTES) return ToolResultBlock.success(text);
            return page(text, start == null ? 1 : start, count == null ? 120 : count);
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error("无法读取此文件。请检查项目路径、访问权限和 UTF-8 文本格式。");
        }
    }

    private static String readUtf8(Path file, long size) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || size > MAX_READ_BYTES) {
            throw new IOException("Expected a regular text file within the read limit");
        }
        byte[] bytes;
        try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            bytes = input.readNBytes((int) size + 1);
        }
        if (bytes.length != size) throw new IOException("File changed during read");
        for (byte value : bytes) {
            if (value == 0) throw new IOException("Binary file");
        }
        return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    }

    private static Stream<String> lines(String text) {
        // Keep the Unicode line separators recognized by the original text search.
        return text.replace('\u000b', '\n').replace('\f', '\n').replace('\u0085', '\n')
                .replace('\u2028', '\n').replace('\u2029', '\n').lines();
    }

    private static ToolResultBlock page(String text, int start, int count) {
        var iterator = lines(text).skip(start - 1L).iterator();
        if (!iterator.hasNext()) return ToolResultBlock.success("[文件结束，第 " + start + " 行无内容]");
        StringBuilder output = new StringBuilder();
        int number = start;
        while (number - start < count && iterator.hasNext()) {
            String line = iterator.next();
            String prefix = number + " | ";
            int remaining = PAGE_CHARS - output.length() - prefix.length() - 1;
            if (!output.isEmpty() && line.length() > remaining) {
                return ToolResultBlock.success(output + "[下一段 start_line=" + number + "]");
            }
            output.append(prefix);
            if (line.length() > remaining) {
                int end = Character.isHighSurrogate(line.charAt(remaining - 1)) ? remaining - 1 : remaining;
                output.append(line, 0, end).append("… [本行过长，已截断]");
            } else {
                output.append(line);
            }
            output.append('\n');
            number++;
        }
        return ToolResultBlock.success(output + (iterator.hasNext() ? "[下一段 start_line=" + number + "]" : "[文件结束]"));
    }

    @Tool(name = "edit_file", description = "Replace one exact text match in an existing UTF-8 project file. Read it first.", concurrencySafe = false)
    public ToolResultBlock edit(
            @ToolParam(name = "path", description = "Project-relative file path") String path,
            @ToolParam(name = "old_text", description = "Exact non-empty text that occurs once") String oldText,
            @ToolParam(name = "new_text", description = "Replacement text, which may be empty") String newText) {
        try {
            Path file = resolve(path);
            String original = readText(file);
            if (original.contains("\r\n") && !original.replace("\r\n", "").contains("\n")) {
                oldText = toCrlf(oldText);
                newText = toCrlf(newText);
            }
            int start = original.indexOf(oldText);
            if (oldText.isEmpty() || start < 0 || original.indexOf(oldText, start + 1) >= 0) {
                return ToolResultBlock.error("原文必须在文件里恰好出现一次。请重新读取文件并提供更具体的原文。");
            }
            String edited = original.substring(0, start) + newText + original.substring(start + oldText.length());
            checkText(edited);
            if (edited.equals(original)) {
                return ToolResultBlock.success("文件内容相同，无需修改。");
            }
            return approval.run("edit_file", root.relativize(file).toString(), oldText, newText,
                    "此次编辑未获批准，文件未更改。", () -> applyEdit(path, file, original, edited));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error(EDIT_FAILURE);
        }
    }

    private ToolResultBlock applyEdit(String path, Path file, String original, String edited) {
        try {
            if (!resolve(path).equals(file)) {
                return ToolResultBlock.error("文件路径已发生变化，请重新读取后再编辑。");
            }
            Path temporary = Files.createTempFile(file.getParent(), ".jharness-", ".tmp");
            try {
                Files.writeString(temporary, edited, StandardCharsets.UTF_8);
                if (!readText(file).equals(original)) {
                    return ToolResultBlock.error("文件已被其他程序更改。请重新读取后再编辑。");
                }
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(temporary);
            }
            return ToolResultBlock.success("已编辑 " + path);
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error(EDIT_FAILURE);
        }
    }

    @Tool(name = "create_file", description = "Create a new UTF-8 project file under an existing directory. Existing files are never overwritten.", concurrencySafe = false)
    public ToolResultBlock create(
            @ToolParam(name = "path", description = "New project-relative file path") String path,
            @ToolParam(name = "content", description = "Complete text for the new file") String content) {
        try {
            Path candidate = projectPath(path);
            if (candidate.equals(root)) {
                return ToolResultBlock.error("请提供新文件的路径。");
            }
            Path parent = resolve(root.relativize(candidate.getParent()).toString());
            checkText(content);
            Path file = parent.resolve(candidate.getFileName());
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                return ToolResultBlock.error("无法创建文件。此路径已存在。");
            }
            return approval.run("create_file", root.relativize(file).toString(), "", content,
                    "此次创建未获批准。", () -> applyCreate(path, candidate, file, content));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error(CREATE_FAILURE);
        }
    }

    private ToolResultBlock applyCreate(String path, Path candidate, Path file, String content) {
        try {
            if (!resolve(root.relativize(candidate.getParent()).toString()).equals(file.getParent())) {
                return ToolResultBlock.error("父目录已发生变化，请重新确认后再创建。");
            }
            Files.writeString(file, content, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
            return ToolResultBlock.success("已创建 " + path);
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error(CREATE_FAILURE);
        }
    }

    private static String readText(Path file) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE_BYTES) {
            throw new IOException("Expected a small regular file");
        }
        String text = Files.readString(file, StandardCharsets.UTF_8);
        checkText(text);
        return text;
    }

    private static void checkText(String text) throws IOException {
        if (text.indexOf(0) >= 0 || text.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) {
            throw new IOException("Expected UTF-8 text of at most 64 KiB");
        }
    }

    private static String toCrlf(String text) {
        return text.replace("\r\n", "\n").replace("\n", "\r\n");
    }

    @Tool(name = "search_files", readOnly = true, description = "Find filenames containing text inside the selected project.")
    public ToolResultBlock search(@ToolParam(name = "query", description = "Case-insensitive filename substring") String query) {
        var matches = new java.util.ArrayList<String>();
        try {
            Files.walkFileTree(root, java.util.EnumSet.noneOf(java.nio.file.FileVisitOption.class), 7,
                    new java.nio.file.SimpleFileVisitor<>() {
                        @Override
                        public java.nio.file.FileVisitResult preVisitDirectory(Path directory,
                                java.nio.file.attribute.BasicFileAttributes attributes) {
                            return directory.equals(root) || visible(directory)
                                    ? java.nio.file.FileVisitResult.CONTINUE
                                    : java.nio.file.FileVisitResult.SKIP_SUBTREE;
                        }

                        @Override
                        public java.nio.file.FileVisitResult visitFile(Path file,
                                java.nio.file.attribute.BasicFileAttributes attributes) {
                            if (attributes.isRegularFile() && visible(file)
                                    && file.getFileName().toString().toLowerCase(java.util.Locale.ROOT)
                                            .contains(query.toLowerCase(java.util.Locale.ROOT))) {
                                matches.add(root.relativize(file).toString());
                            }
                            return matches.size() >= 80 ? java.nio.file.FileVisitResult.TERMINATE
                                    : java.nio.file.FileVisitResult.CONTINUE;
                        }
                    });
            return ToolResultBlock.success(matches.isEmpty() ? "未找到匹配文件。" : String.join("\n", matches));
        } catch (IOException e) {
            return ToolResultBlock.error("无法搜索此项目。");
        }
    }

    private Path resolve(String path) throws IOException {
        Path real = projectPath(path).toRealPath();
        checkProjectPath(real);
        return real;
    }

    @Tool(name = "search_text", readOnly = true,
            description = "Find literal text in UTF-8 project files. Returns paths, line numbers and coverage. Narrow path when a search limit is reached.")
    public ToolResultBlock searchText(
            @ToolParam(name = "query", description = "Case-insensitive literal text") String query,
            @ToolParam(name = "path", description = "Project-relative directory or file; omit for root", required = false)
            String path) {
        if (query == null || query.isBlank()) return ToolResultBlock.error("请输入要查找的文字。");
        try {
            Path directory = resolve(path == null ? "." : path);
            var search = new TextSearch(query);
            Files.walkFileTree(directory, EnumSet.noneOf(java.nio.file.FileVisitOption.class), SEARCH_DEPTH, search);
            return ToolResultBlock.success(search.result());
        } catch (IOException | IllegalArgumentException error) {
            return ToolResultBlock.error("无法搜索此项目路径。");
        }
    }

    private final class TextSearch extends SimpleFileVisitor<Path> {
        private final Pattern needle;
        private final List<String> matches = new ArrayList<>();
        private int candidates;
        private int scanned;
        private int skipped;
        private int oversized;
        private int depthLimited;
        private long bytes;
        private String stopped = "";

        TextSearch(String query) {
            needle = Pattern.compile(query, Pattern.LITERAL | Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
        }

        @Override
        public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) {
            if (directory.equals(root)) return FileVisitResult.CONTINUE;
            if (!visible(directory)) return FileVisitResult.SKIP_SUBTREE;
            try {
                checkProjectPath(directory.toRealPath());
                return FileVisitResult.CONTINUE;
            } catch (IOException e) {
                skipped++;
                return FileVisitResult.SKIP_SUBTREE;
            }
        }

        @Override
        public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
            if (!visible(file)) return FileVisitResult.CONTINUE;
            if (attributes.isDirectory()) depthLimited++;
            if (!attributes.isRegularFile()) return FileVisitResult.CONTINUE;
            if (candidates >= SEARCH_FILES) return stop("候选文件上限 " + SEARCH_FILES);
            candidates++;
            long size = attributes.size();
            if (size > MAX_READ_BYTES) {
                oversized++;
                return FileVisitResult.CONTINUE;
            }
            if (bytes + size > SEARCH_BYTES) return stop("总读取上限 64 MiB");
            bytes += size;
            try {
                Path relative = root.relativize(file);
                String text = readUtf8(resolve(relative.toString()), size);
                scanned++;
                var iterator = lines(text).iterator();
                for (int number = 1; iterator.hasNext(); number++) {
                    String line = iterator.next();
                    var match = needle.matcher(line);
                    if (!match.find()) continue;
                    int start = Math.max(0, match.start() - 40);
                    String excerpt = line.substring(start, Math.min(line.length(), start + 180)).strip();
                    matches.add(relative + ":" + number + " " + excerpt);
                    if (matches.size() == SEARCH_MATCHES) return stop("最多显示 " + SEARCH_MATCHES + " 条");
                }
            } catch (IOException e) {
                skipped++;
            }
            return FileVisitResult.CONTINUE;
        }

        @Override
        public FileVisitResult visitFileFailed(Path file, IOException error) {
            skipped++;
            return FileVisitResult.CONTINUE;
        }

        @Override
        public FileVisitResult postVisitDirectory(Path directory, IOException error) {
            if (error != null) skipped++;
            return FileVisitResult.CONTINUE;
        }

        private FileVisitResult stop(String reason) {
            stopped = "；触及" + reason;
            return FileVisitResult.TERMINATE;
        }

        String result() {
            String hits = matches.isEmpty() ? "已扫描范围内未找到匹配。" : String.join("\n", matches);
            return hits + "\n[已扫描 " + scanned + " 个文本文件；跳过 " + (skipped + oversized)
                    + " 项（超出 8 MiB " + oversized + " 个，非文本或无法访问 " + skipped + " 项）；按项目排除规则过滤"
                    + (depthLimited == 0 ? "" : "；" + depthLimited + " 个目录触及深度上限 " + SEARCH_DEPTH)
                    + stopped + "]";
        }
    }

    private Path projectPath(String path) throws IOException {
        Path relative = Path.of(path);
        if (relative.isAbsolute() || relative.getRoot() != null) {
            throw new IOException("Expected a project-relative path");
        }
        Path candidate = root.resolve(relative).normalize();
        checkProjectPath(candidate);
        return candidate;
    }

    private void checkProjectPath(Path path) throws IOException {
        if (!path.startsWith(root)) {
            throw new IOException("Path outside project");
        }
        for (Path component : root.relativize(path)) {
            if (!component.toString().isEmpty() && !visible(component)) {
                throw new IOException("Excluded path");
            }
        }
    }

    private boolean visible(Path path) {
        String name = path.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
        return !name.startsWith(".") && !name.endsWith(".") && !name.endsWith(" ")
                && !name.contains(":") && !name.equals("node_modules") && !name.equals("target")
                && !name.equals("build") && !name.equals("dist")
                && !name.endsWith(".pem") && !name.endsWith(".key");
    }
}
