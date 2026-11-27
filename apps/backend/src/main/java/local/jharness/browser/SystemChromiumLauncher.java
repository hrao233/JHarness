package local.jharness.browser;

import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;

final class SystemChromiumLauncher implements AutoCloseable {
    private Process process;
    private FileChannel lockChannel;
    private FileLock lock;

    URI launch(Path profile) throws Exception {
        String injected = System.getenv("JHARNESS_BROWSER_WS_URL");
        if (injected != null && !injected.isBlank()) return localSocket(injected);
        String port = System.getenv("JHARNESS_BROWSER_PORT");
        if (port != null && !port.isBlank()) return page(Integer.parseInt(port));
        Path executable = executable();
        Files.createDirectories(profile);
        lockChannel = FileChannel.open(profile.resolve(".jharness.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        lock = lockChannel.tryLock();
        if (lock == null) throw new IOException("其他后端正在使用此项目的浏览器");
        Path marker = profile.resolve("DevToolsActivePort");
        Files.deleteIfExists(marker);
        process = new ProcessBuilder(executable.toString(), "--user-data-dir=" + profile,
                "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
                "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
                "--disable-background-networking", "about:blank")
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        long deadline = System.nanoTime() + Duration.ofSeconds(12).toNanos();
        while (process.isAlive() && System.nanoTime() < deadline) {
            if (Files.exists(marker)) {
                try { return page(Integer.parseInt(Files.readAllLines(marker).get(0))); }
                catch (IOException | IndexOutOfBoundsException | NumberFormatException ignored) {}
            }
            Thread.sleep(80);
        }
        throw new IOException("本机 Chromium 未提供可用的页面连接");
    }

    private static Path executable() throws IOException {
        for (String root : List.of("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")) {
            String dir = System.getenv(root);
            if (dir == null) continue;
            for (String name : List.of("Microsoft/Edge/Application/msedge.exe","Google/Chrome/Application/chrome.exe")) {
                Path path = Path.of(dir, name);
                if (Files.isRegularFile(path)) return path;
            }
        }
        throw new IOException("未找到 Microsoft Edge 或 Google Chrome");
    }
    static URI localSocket(String url) {
        URI endpoint = URI.create(url);
        if (!"ws".equals(endpoint.getScheme()) || !Set.of("127.0.0.1","localhost","[::1]").contains(endpoint.getHost())
                || endpoint.getPort() <= 0 || endpoint.getRawUserInfo() != null)
            throw new IllegalArgumentException("浏览器桥必须使用本机回环地址");
        return endpoint;
    }
    private static URI page(int port) throws Exception {
        URI list = URI.create("http://127.0.0.1:" + port + "/json/list");
        var response = CdpClient.HTTP.send(HttpRequest.newBuilder(list).timeout(Duration.ofSeconds(2)).build(),
                HttpResponse.BodyHandlers.ofString());
        for (var target : CdpClient.JSON.readTree(response.body()))
            if ("page".equals(target.path("type").asText())) return localSocket(target.path("webSocketDebuggerUrl").asText());
        throw new IOException("未找到 Chromium 页面");
    }
    @Override public void close() {
        if (process != null) {
            var children = process.descendants().toList();
            process.destroyForcibly();
            children.forEach(ProcessHandle::destroyForcibly);
        }
        try { if (lock != null) lock.release(); } catch (IOException ignored) {}
        try { if (lockChannel != null) lockChannel.close(); } catch (IOException ignored) {}
    }
}
