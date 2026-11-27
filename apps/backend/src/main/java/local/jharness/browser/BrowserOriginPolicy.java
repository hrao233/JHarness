package local.jharness.browser;

import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.regex.Pattern;

public final class BrowserOriginPolicy {
    private static final String INVALID_URL = "仅支持有效的 HTTP(S) 网页地址";
    private static final Pattern EXPLICIT_SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*:.*");
    private static final Pattern HOST_PORT = Pattern.compile("^[^/:?#\\s]+:\\d{1,5}(?:[/?#].*)?$");
    private static final Pattern LOCAL_AUTHORITY = Pattern.compile(
            "^(?:localhost|127(?:\\.\\d{1,3}){3}|\\[::1\\]|0\\.0\\.0\\.0|10(?:\\.\\d{1,3}){3}"
                    + "|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}"
                    + "|[^.:/?#\\s]+\\.(?:local|localhost|test))(?::\\d{1,5})?$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern IPV4_AUTHORITY = Pattern.compile("^\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?$");
    private static final Pattern IPV6_AUTHORITY = Pattern.compile("^\\[[0-9a-fA-F:]+\\](?::\\d{1,5})?$");

    private final boolean full;
    private final Set<String> approved;
    private final Set<String> declined;
    private final BiPredicate<String, String> ask;

    BrowserOriginPolicy(boolean full, Set<String> approved, Set<String> declined, BiPredicate<String, String> ask) {
        this.full = full;
        this.approved = approved;
        this.declined = declined;
        this.ask = ask;
    }

    /**
     * Normalizes user omnibox input (bare domains like baidu.com, localhost:port, LAN IPs, or search terms)
     * into a valid HTTP(S) URL while preserving explicit schemes so disallowed protocols still fail validation.
     */
    public static String normalizeAddress(String raw, boolean allowSearch) {
        String value = raw == null ? "" : raw.strip();
        if (value.isEmpty()) throw new IllegalArgumentException(INVALID_URL);
        if (EXPLICIT_SCHEME.matcher(value).matches() && !HOST_PORT.matcher(value).matches()) {
            return value.regionMatches(true, 0, "http://", 0, 7) || value.regionMatches(true, 0, "https://", 0, 8)
                    ? value.replace(" ", "%20") : value;
        }
        if (value.startsWith("//")) return "https:" + value;
        if (value.chars().anyMatch(Character::isWhitespace)) {
            if (!allowSearch) throw new IllegalArgumentException(INVALID_URL);
            return searchUrl(value);
        }
        int slash = firstDelimiter(value);
        String authority = slash < 0 ? value : value.substring(0, slash);
        String suffix = slash < 0 ? "" : value.substring(slash);
        if (LOCAL_AUTHORITY.matcher(authority).matches()) {
            String host = authority.replaceFirst("^0\\.0\\.0\\.0(?=:|$)", "127.0.0.1");
            return "http://" + host + suffix;
        }
        boolean ipv4 = IPV4_AUTHORITY.matcher(authority).matches();
        boolean ipv6 = IPV6_AUTHORITY.matcher(authority).matches();
        int colon = ipv6 ? authority.lastIndexOf(':') : authority.indexOf(':');
        boolean hasPort = colon > 0 && (!ipv6 || colon > authority.indexOf(']'))
                && authority.substring(colon + 1).matches("\\d{1,5}");
        String hostOnly = hasPort ? authority.substring(0, colon) : authority;
        boolean domain = !ipv4 && !ipv6 && hostOnly.indexOf('.') > 0
                && !hostOnly.startsWith(".") && !hostOnly.endsWith(".")
                && !hostOnly.contains("..") && !hostOnly.substring(hostOnly.lastIndexOf('.') + 1).matches("\\d+");
        if (ipv4 || ipv6 || domain || hasPort) {
            boolean useHttp = hasPort && !authority.endsWith(":443");
            return (useHttp ? "http://" : "https://") + authority + suffix;
        }
        if (allowSearch) return searchUrl(value);
        throw new IllegalArgumentException(INVALID_URL);
    }

    private static String searchUrl(String query) {
        return "https://www.bing.com/search?q="
                + URLEncoder.encode(query, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static int firstDelimiter(String text) {
        int end = -1;
        for (char sep : new char[]{'/', '?', '#'}) {
            int idx = text.indexOf(sep);
            if (idx >= 0 && (end < 0 || idx < end)) end = idx;
        }
        return end;
    }

    public static String origin(String url) {
        if (url == null || url.contains("\\") || url.chars().anyMatch(ch -> ch <= 0x20 || ch == 0x7F))
            throw new IllegalArgumentException(INVALID_URL);
        int colon = url.indexOf("://");
        if (colon <= 0) throw new IllegalArgumentException(INVALID_URL);
        String scheme = url.substring(0, colon).toLowerCase(Locale.ROOT);
        if (!Set.of("http", "https").contains(scheme))
            throw new IllegalArgumentException(INVALID_URL);
        String rest = url.substring(colon + 3);
        int sep = firstDelimiter(rest);
        String authority = sep < 0 ? rest : rest.substring(0, sep);
        if (authority.isEmpty() || authority.contains("@"))
            throw new IllegalArgumentException(INVALID_URL);
        String host;
        int port = -1;
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close <= 1) throw new IllegalArgumentException(INVALID_URL);
            host = authority.substring(0, close + 1);
            if (close + 1 < authority.length()) {
                if (authority.charAt(close + 1) != ':') throw new IllegalArgumentException(INVALID_URL);
                port = parsePort(authority.substring(close + 2));
            }
        } else {
            int portSep = authority.indexOf(':');
            if (portSep >= 0) {
                if (authority.indexOf(':', portSep + 1) >= 0) throw new IllegalArgumentException(INVALID_URL);
                host = authority.substring(0, portSep);
                port = parsePort(authority.substring(portSep + 1));
            } else {
                host = authority;
            }
            if (host.isEmpty()) throw new IllegalArgumentException(INVALID_URL);
            try {
                host = IDN.toASCII(host, IDN.ALLOW_UNASSIGNED);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException(INVALID_URL);
            }
            if (host.isEmpty()) throw new IllegalArgumentException(INVALID_URL);
        }
        URI uri;
        try {
            uri = new URI(scheme + "://" + host + (port == -1 ? "" : ":" + port));
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException(INVALID_URL);
        }
        if (uri.getHost() == null || uri.getRawUserInfo() != null)
            throw new IllegalArgumentException(INVALID_URL);
        boolean standard = port == -1 || (scheme.equals("http") ? port == 80 : port == 443);
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (standard ? "" : ":" + port);
    }

    private static int parsePort(String text) {
        if (text.isEmpty() || text.length() > 5 || !text.chars().allMatch(Character::isDigit))
            throw new IllegalArgumentException(INVALID_URL);
        int port = Integer.parseInt(text);
        if (port > 65535) throw new IllegalArgumentException(INVALID_URL);
        return port;
    }

    private boolean alreadyApproved(String origin) {
        return approved.contains(origin) || Set.of("127.0.0.1", "[::1]", "localhost").contains(URI.create(origin).getHost());
    }

    synchronized boolean permitsSubframe(String url, String mainUrl) {
        String origin = origin(url);
        return !declined.contains(origin) && (alreadyApproved(origin)
                || (full && origin.equals(origin(mainUrl))));
    }

    synchronized boolean permits(String url) {
        String origin = origin(url);
        if (declined.contains(origin)) return false;
        if (full || alreadyApproved(origin)) return true;
        if (!ask.test(origin, url)) {
            declined.add(origin);
            return false;
        }
        approved.add(origin);
        return true;
    }
}
