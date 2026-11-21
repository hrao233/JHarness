package local.jharness.agent;

import io.agentscope.core.message.ToolResultBlock;
import io.agentscope.core.tool.Tool;
import io.agentscope.core.tool.ToolParam;
import java.io.IOException;
import java.nio.file.Path;
import local.jharness.plugin.ExternalPluginManager;

public final class PluginInstaller {
    static final String INSTRUCTIONS = """
            创造模式下，用户要求创建或安装工具插件时，可以在项目内编写插件，然后调用 install_plugin。
            插件目录内写 jharness-plugin.json，例如
            {"id":"example.echo","name":"Echo","version":"1.0.0","apiVersion":1,"executable":"node","arguments":["plugin.cjs"],
             "tools":[{"name":"example_echo","description":"Echo text","readOnly":true,"inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}
            脚本从 stdin 逐行读取 JSON。method 为 tool_call 时，从 params.tool、params.input 读取调用并向 stdout 写一行
            {"id":原请求ID,"result":{"text":"返回值"}}，失败返回 {"id":原请求ID,"error":"原因"}。shutdown 时退出。
            获批安装后，下一条用户消息可使用新工具。
            """;
    private final Path project;
    private final ExternalPluginManager manager;
    private final ApprovedOperation approval;

    PluginInstaller(Path project, ExternalPluginManager manager, ApprovedOperation approval) {
        this.project = project;
        this.manager = manager;
        this.approval = approval;
    }

    @Tool(name = "install_plugin", concurrencySafe = false, description = "Ask the user to install and enable a local JHarness tool plugin for the current project using an approved copy.")
    public ToolResultBlock install(@ToolParam(name = "directory", description = "Plugin directory relative to the project") String directory) {
        try {
            var root = project.toRealPath();
            var folder = root.resolve(directory).toRealPath();
            if (!folder.startsWith(root)) return ToolResultBlock.error("插件目录必须位于当前项目内。");
            var plugin = manager.preview(folder);
            String details = plugin.id() + " " + plugin.version() + "\nSHA-256：" + plugin.digest() + "\n程序：" + plugin.executable()
                    + "\n参数：" + plugin.arguments() + "\n工具："
                    + plugin.tools().stream().map(ExternalPluginManager.ToolSpec::name).toList();
            return approval.run("install_plugin", folder.toString(), "", details, "插件安装未获批准。", () -> {
                try {
                    manager.installEnabled(plugin);
                    return ToolResultBlock.success("已安装并启用 " + plugin.id() + "，下一条消息可使用。");
                } catch (IOException | RuntimeException error) {
                    return ToolResultBlock.error("安装失败：" + error.getMessage());
                }
            });
        } catch (IOException | RuntimeException error) {
            return ToolResultBlock.error("无法读取插件：" + error.getMessage());
        }
    }
}
