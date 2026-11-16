package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import io.agentscope.harness.agent.tool.WebTools;
import java.net.URI;

public final class ApprovedWeb {
    private final ApprovedOperation approval;
    private final WebTools.WebFetchTool fetch = new WebTools.WebFetchTool();
    private final WebTools.WebSearchTool search = new WebTools.WebSearchTool();

    ApprovedWeb(ApprovedOperation approval) {
        this.approval = approval;
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
        return approval.run("web_fetch", "", "", url, "网页请求未获批准。", () -> fetch.webFetch(url, 12000));
    }

    @Tool(name = "web_search", readOnly = true,
            description = "Search Tavily after the user approves the exact query sent to the service.")
    public ToolResultBlock search(@ToolParam(name = "query", description = "Search query") String query) {
        if (query == null || query.isBlank() || query.length() > 1000) {
            return ToolResultBlock.error("请输入 1,000 字符以内的查询。");
        }
        return approval.run("web_search", "api.tavily.com", "", query, "网页搜索未获批准。",
                () -> search.webSearch(query, 5));
    }
}
