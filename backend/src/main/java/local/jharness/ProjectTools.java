package local.jharness;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.stream.Stream;

public final class ProjectTools {
    private static final int MAX_FILE_BYTES = 64 * 1024;
    private final Path root;

    ProjectTools(Path root) throws IOException {
        this.root = root.toRealPath();
        if (!Files.isDirectory(this.root)) {
            throw new IOException("请选择有效的项目文件夹。");
        }
    }

    @Tool(name = "list_files", description = "List entries in a directory inside the selected project.")
    public ToolResultBlock list(@ToolParam(name = "path", description = "Project-relative directory; use . for the root") String path) {
        try (Stream<Path> files = Files.list(resolve(path))) {
            return ToolResultBlock.success(String.join("\n", files.filter(this::visible)
                    .limit(200).map(file -> file.getFileName() + (Files.isDirectory(file) ? "/" : ""))
                    .sorted().toList()));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error("无法列出此目录。");
        }
    }

    @Tool(name = "read_file", description = "Read a UTF-8 source or documentation file inside the project.")
    public ToolResultBlock read(@ToolParam(name = "path", description = "Project-relative file path") String path) {
        try {
            Path file = resolve(path);
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE_BYTES) {
                return ToolResultBlock.error("只支持 64 KiB 以内的文本文件。");
            }
            return ToolResultBlock.success(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException | IllegalArgumentException e) {
            return ToolResultBlock.error("无法读取此文件。请检查项目路径和文件编码。");
        }
    }

    @Tool(name = "search_files", description = "Find filenames containing text inside the selected project.")
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
        Path relative = Path.of(path);
        if (relative.isAbsolute() || relative.getRoot() != null) {
            throw new IOException("Expected a project-relative path");
        }
        Path candidate = root.resolve(relative).normalize();
        if (!candidate.startsWith(root)) {
            throw new IOException("Path outside project");
        }
        for (Path component : root.relativize(candidate)) {
            if (!component.toString().isEmpty() && !visible(component)) {
                throw new IOException("Excluded path");
            }
        }
        Path real = candidate.toRealPath();
        if (!real.startsWith(root)) {
            throw new IOException("Path outside project");
        }
        for (Path component : root.relativize(real)) {
            if (!component.toString().isEmpty() && !visible(component)) {
                throw new IOException("Excluded path");
            }
        }
        return real;
    }

    private boolean visible(Path path) {
        String name = path.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
        return !name.startsWith(".") && !name.equals("node_modules") && !name.equals("target")
                && !name.equals("build") && !name.equals("dist")
                && !name.endsWith(".pem") && !name.endsWith(".key");
    }
}
