package local.jharness.plugin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;

/** Content-addressed copies of files inside an approved plugin directory. */
final class PluginSnapshots {
    record Contents(String digest, Map<String, String> files) {}
    private final Path root;

    PluginSnapshots(Path registry) {
        root = registry.resolve(".plugin-versions").toAbsolutePath().normalize();
    }

    Path directory(String digest) {
        if (digest == null || !digest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("插件版本摘要无效。");
        return root.resolve(digest);
    }

    Contents inspect(Path source) throws IOException {
        return scan(source.toRealPath(), null);
    }

    Path pin(Path source, String expected) throws IOException {
        source = source.toRealPath();
        Files.createDirectories(root);
        if (root.toRealPath().startsWith(source)) throw new IOException("请选择单独的插件目录。");
        Path dest = directory(expected);
        Path stage = Files.createTempDirectory(root, ".install-");
        try {
            if (!scan(source, stage).digest().equals(expected)) throw new IOException("插件文件已更改，请重新预览。");
            if (Files.exists(dest)) {
                if (!inspect(dest).digest().equals(expected)) throw new IOException("已保存的插件副本校验失败。");
            } else {
                Files.move(stage, dest, StandardCopyOption.ATOMIC_MOVE);
            }
            return dest.toRealPath();
        } finally {
            if (Files.exists(stage)) {
                try (var entries = Files.walk(stage)) {
                    for (Path file : entries.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(file);
                }
            }
        }
    }

    private Contents scan(Path source, Path dest) throws IOException {
        var files = new TreeMap<String, String>();
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                Path relative = source.relativize(dir);
                if (!dir.toRealPath().equals(dir) || attrs.isOther()) throw new IOException("插件包含链接目录：" + relative);
                if (!relative.toString().isEmpty())
                    files.put(relative.toString().replace(java.io.File.separatorChar, '/') + "/", "directory");
                if (dest != null) Files.createDirectories(dest.resolve(relative));
                return FileVisitResult.CONTINUE;
            }

            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Path relative = source.relativize(file);
                if (!attrs.isRegularFile() || !file.toRealPath().equals(file)) throw new IOException("插件包含链接或特殊文件：" + relative);
                var hash = sha256();
                try (var input = new java.security.DigestInputStream(
                        Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS), hash)) {
                    if (dest == null) input.transferTo(java.io.OutputStream.nullOutputStream());
                    else Files.copy(input, dest.resolve(relative));
                }
                files.put(relative.toString().replace(java.io.File.separatorChar, '/'), HexFormat.of().formatHex(hash.digest()));
                return FileVisitResult.CONTINUE;
            }
        });
        var hash = sha256();
        files.forEach((path, digest) -> {
            hash.update(path.getBytes(StandardCharsets.UTF_8));
            hash.update((byte) 0);
            hash.update(digest.getBytes(StandardCharsets.US_ASCII));
        });
        return new Contents(HexFormat.of().formatHex(hash.digest()), files);
    }

    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
