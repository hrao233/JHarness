package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.stream.Stream;

public final class ProjectTools {
    private static final int MAX_FILE_BYTES = 64 * 1024;
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

    @Tool(name = "read_file", readOnly = true, description = "Read a UTF-8 source or documentation file inside the project.")
    public ToolResultBlock read(@ToolParam(name = "path", description = "Project-relative file path") String path) {
        try {
            return ToolResultBlock.success(readText(resolve(path)));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error("无法读取此文件。请检查项目路径、UTF-8 编码和 64 KiB 大小限制。");
        }
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
            description = "Find literal text in UTF-8 project files and return relative paths and line numbers.")
    public ToolResultBlock searchText(
            @ToolParam(name = "query", description = "Case-insensitive literal text") String query,
            @ToolParam(name = "path", description = "Project-relative directory or file; omit for root", required = false)
            String path) {
        if (query == null || query.isBlank()) return ToolResultBlock.error("请输入要查找的文字。");
        String needle = query.toLowerCase(java.util.Locale.ROOT);
        var matches = new java.util.ArrayList<String>();
        try (Stream<Path> files = Files.find(resolve(path == null ? "." : path), 9,
                (file, attributes) -> attributes.isRegularFile() && allowedFile(file))) {
            var candidates = files.limit(3000).iterator();
            while (candidates.hasNext() && matches.size() < 40) {
                Path file = candidates.next();
                String text;
                try {
                    text = readText(resolve(root.relativize(file).toString()));
                } catch (IOException | IllegalArgumentException error) {
                    continue;
                }
                String[] lines = text.split("\\R", -1);
                for (int i = 0; i < lines.length && matches.size() < 40; i++) {
                    int index = lines[i].toLowerCase(java.util.Locale.ROOT).indexOf(needle);
                    if (index < 0) continue;
                    int start = Math.min(lines[i].length(), Math.max(0, index - 40));
                    String excerpt = lines[i].substring(start, Math.min(lines[i].length(), start + 180)).strip();
                    matches.add(root.relativize(file) + ":" + (i + 1) + " " + excerpt);
                }
            }
            return ToolResultBlock.success(matches.isEmpty() ? "未找到匹配。"
                    : String.join("\n", matches) + (matches.size() == 40 ? "\n[最多显示 40 条]" : ""));
        } catch (IOException | IllegalArgumentException | java.io.UncheckedIOException error) {
            return ToolResultBlock.error("无法搜索此项目路径。");
        }
    }

    private boolean allowedFile(Path file) {
        try {
            checkProjectPath(file);
            return true;
        } catch (IOException error) {
            return false;
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
