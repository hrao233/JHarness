package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import io.agentscope.harness.agent.tool.WebTools;
import java.net.URI;
import java.util.function.BiPredicate;

public final class ApprovedWeb {
    private final BiPredicate<String, String> approve;
    private final WebTools.WebFetchTool fetch = new WebTools.WebFetchTool();
    private final WebTools.WebSearchTool search = new WebTools.WebSearchTool();

    ApprovedWeb(BiPredicate<String, String> approve) {
        this.approve = approve;
    }

    @Tool(name = "web_fetch", readOnly = true,
            description = "Read a URL over HTTP(S) after the user approves sending a request to that URL.")
    public ToolResultBlock fetch(@ToolParam(name = "url", description = "Exact HTTP(S) URL") String url) {
        URI target;
        try {
            target = URI.create(url);
        } catch (IllegalArgumentException | NullPointerException error) {
            return ToolResultBlock.error("请输入有效的 HTTP(S) 地址。");
        }
        if (!("http".equals(target.getScheme()) || "https".equals(target.getScheme()))
                || target.getHost() == null || target.getRawUserInfo() != null || url.length() > 4000) {
            return ToolResultBlock.error("请输入不含凭证的 HTTP(S) 地址。");
        }
        if (!approve.test("web_fetch", url)) return ToolResultBlock.error("网页请求未获批准。");
        return fetch.webFetch(url, 12000);
    }

    @Tool(name = "web_search", readOnly = true,
            description = "Search Tavily after the user approves the exact query sent to the service.")
    public ToolResultBlock search(@ToolParam(name = "query", description = "Search query") String query) {
        if (query == null || query.isBlank() || query.length() > 1000) {
            return ToolResultBlock.error("请输入 1,000 字符以内的查询。");
        }
        if (!approve.test("web_search", query)) return ToolResultBlock.error("网页搜索未获批准。");
        return search.webSearch(query, 5);
    }
}
