package local.jharness.agent;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

record CommandOutput(String text, boolean truncated, boolean logComplete) {
    private static final int HALF = 6000;

    static CommandOutput capture(InputStream input, Path log) throws IOException {
        var head = new ByteArrayOutputStream(HALF);
        byte[] tail = new byte[HALF];
        int cursor = 0;
        long tailBytes = 0;
        OutputStream archive = null;
        if (log != null) {
            try {
                Files.createDirectories(log.getParent());
                archive = Files.newOutputStream(log, StandardOpenOption.CREATE_NEW);
            } catch (IOException ignored) {
                // Continue draining the child even if the workspace cannot store a log.
            }
        }
        boolean complete = false;
        try (input) {
            byte[] buffer = new byte[4096];
            int n;
            while ((n = input.read(buffer)) != -1) {
                if (archive != null) {
                    try {
                        archive.write(buffer, 0, n);
                    } catch (IOException e) {
                        try { archive.close(); } catch (IOException ignored) { }
                        archive = null;
                    }
                }
                int prefix = Math.min(n, HALF - head.size());
                head.write(buffer, 0, prefix);
                int count = n - prefix;
                int first = Math.min(count, HALF - cursor);
                System.arraycopy(buffer, prefix, tail, cursor, first);
                System.arraycopy(buffer, prefix + first, tail, 0, count - first);
                cursor = (cursor + count) % HALF;
                tailBytes += count;
            }
            complete = archive != null;
        } finally {
            if (archive != null) {
                try { archive.close(); } catch (IOException e) { complete = false; }
            }
        }
        boolean truncated = tailBytes > HALF;
        if (truncated) {
            head.writeBytes("\n[输出已截断，保留首尾]\n".getBytes(StandardCharsets.UTF_8));
            head.write(tail, cursor, HALF - cursor);
            head.write(tail, 0, cursor);
        } else {
            head.write(tail, 0, (int) tailBytes);
        }
        return new CommandOutput(head.toString(StandardCharsets.UTF_8), truncated, complete);
    }
}
