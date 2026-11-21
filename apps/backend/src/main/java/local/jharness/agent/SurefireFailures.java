package local.jharness.agent;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.*;
import java.util.regex.Pattern;
import javax.xml.stream.*;

/** Summarizes newly written Maven test reports when a build fails. */
final class SurefireFailures {
    private static final Pattern MAVEN = Pattern.compile("(?i)(?<![\\w-])mvnw?(?:\\.cmd|\\.bat)?(?![\\w.-])");
    private final Map<Path, FileTime> before;
    private final Path project;

    private SurefireFailures(Path project) {
        this.project = project;
        before = reports(project);
    }

    static SurefireFailures beforeCommand(Path project, String command) {
        if (!MAVEN.matcher(command).find()) return null;
        try { return new SurefireFailures(project.toRealPath()); }
        catch (IOException e) { return null; }
    }

    private static Map<Path, FileTime> reports(Path project) {
        Map<Path, FileTime> files = new TreeMap<>();
        try {
            Files.walkFileTree(project, EnumSet.noneOf(FileVisitOption.class), 32, new SimpleFileVisitor<>() {
                @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                    if (dir.equals(project)) return FileVisitResult.CONTINUE;
                    String name = dir.getFileName().toString();
                    if (attrs.isOther() || !dir.toRealPath().equals(dir) || name.startsWith(".")
                            || Set.of("node_modules", "dist", "build", "release", "runtime").contains(name))
                        return FileVisitResult.SKIP_SUBTREE;
                    if (!name.equals("target")) return FileVisitResult.CONTINUE;
                    Path reportDir = dir.resolve("surefire-reports");
                    if (Files.isDirectory(reportDir, LinkOption.NOFOLLOW_LINKS) && reportDir.toRealPath().equals(reportDir)) {
                        try (var entries = Files.newDirectoryStream(reportDir, "TEST-*.xml")) {
                            for (Path file : entries) {
                                if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
                                    files.put(file, Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS));
                            }
                        }
                    }
                    return FileVisitResult.SKIP_SUBTREE;
                }
                @Override public FileVisitResult visitFileFailed(Path file, IOException error) { return FileVisitResult.CONTINUE; }
            });
        } catch (IOException ignored) { }
        return files;
    }

    List<String> failures() {
        var failures = new ArrayList<String>();
        for (var report : reports(project).entrySet()) {
            if (report.getValue().equals(before.get(report.getKey()))) continue;
            read(report.getKey(), failures);
            if (failures.size() >= 10) break;
        }
        return List.copyOf(failures);
    }

    private void read(Path file, List<String> failures) {
        var factory = XMLInputFactory.newFactory();
        factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        factory.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            var xml = factory.createXMLStreamReader(input);
            try {
                String test = null;
                while (xml.hasNext() && failures.size() < 10) {
                    int event = xml.next();
                    if (event == XMLStreamConstants.START_ELEMENT) {
                        switch (xml.getLocalName()) {
                            case "testcase" -> test = attribute(xml, "classname") + "#" + attribute(xml, "name");
                            case "failure", "error" -> {
                                if (test != null) failures.add(test + " · " + attribute(xml, "message") + " (" + project.relativize(file) + ")");
                            }
                            default -> { }
                        }
                    } else if (event == XMLStreamConstants.END_ELEMENT && xml.getLocalName().equals("testcase")) test = null;
                }
            } finally { xml.close(); }
        } catch (IOException | XMLStreamException ignored) { }
    }

    private static String attribute(XMLStreamReader xml, String name) {
        String value = xml.getAttributeValue(null, name);
        if (value == null) return "";
        return value.substring(0, Math.min(180, value.length())).replace('\n', ' ').replace('\r', ' ');
    }
}
