# JHarness

Windows 本地项目助手。桌面窗口由 Electron 和 React 提供，Java 后端使用 AgentScope Core 和 Harness。应用通过进程管道传输 JSON 行和流式事件。

## 使用

双击 `release/win-unpacked/JHarness.exe`。在「设置」填写 API Key 并测试连接。DeepSeek 官方预填 `deepseek-flash`。自定义 OpenAI 兼容接口需要填写 Base URL（例如 `https://example.com/v1`）和模型 ID。

打开本机项目目录，发送「读一下 README，解释项目结构」。点击工具记录查看参数与结果。关闭窗口后再次打开，可以从侧栏打开已保存的会话。聊天时，用户输入和 Agent 读取的相关文本会发送给配置的模型服务。

### 输入栏与会话

- 「＋」添加 UTF-8 文本、PNG/JPEG 截图、文件夹目录清单或项目 Skill。图片需要支持视觉输入的模型。文本单项上限 64 KiB，图片单项上限 5 MiB，每条消息最多 8 项。
- Skill 放在项目的 `.agents/skills/<名称>/SKILL.md` 或 `skills/<名称>/SKILL.md`。插件放在 `plugins/<名称>/`，含 `.codex-plugin/plugin.json`，菜单可以选中插件的 Skill。应用将所选 Skill 正文作为本次消息的工作指引传给模型。
- 「请求批准」会拦住每次写入，可在输入栏上方查看原文和替换内容，然后批准一次或拒绝。「帮我批准」自动放行原文和新文各不超过 2,000 字符、且新文非空白的替换。「完全访问权限」允许项目内使用现有文件工具，无需逐次审批。
- 「设置」可保存多个 API 配置和一个默认模型。右侧模型按钮打开推理强度滑块，点弹层里的模型名进入模型列表。DeepSeek 官方支持关闭、低、高和极高。「默认」采用服务商默认强度。使用 OpenAI 兼容接口时，所选强度以 `reasoning_effort` 发送，支持范围由对应服务商决定。
- 左侧分别显示最近会话和项目。项目行的「＋」会在该项目新建会话，项目名前的箭头展开或收起会话。

Agent 可以浏览目录、按名称查找、读取、编辑和新建项目内的 UTF-8 文本文件，单文件上限为 64 KiB。编辑时匹配唯一一处原文。新建文件使用已有目录。会话使用 Harness 持久日志。跨会话长期记忆和命令执行留待后续版本。模型 Key 由 Electron 主进程通过 Windows DPAPI 加密，数据位于应用的用户数据目录。

## 开发

需要 Windows x64、JDK 21、Maven 和 Node.js。当前后端使用 AgentScope Java `2.1.0-SNAPSHOT` 的本地 Maven 构件。若本机尚未安装该版本，在对应 AgentScope Java 源码根目录构建：

```powershell
mvn -T1C -pl agentscope-harness,agentscope-extensions/agentscope-extensions-model/agentscope-extensions-model-openai -am -DskipTests install
```

然后在 JHarness 根目录运行：

```powershell
npm ci
mvn -T1C -f backend/pom.xml package
& "$env:JAVA_HOME/bin/jlink.exe" --add-modules java.se,jdk.unsupported,jdk.crypto.ec,jdk.charsets,jdk.zipfs --strip-debug --no-header-files --no-man-pages --compress=zip-6 --output runtime
npm test
npm run package:win
```

`npm test` 使用本地模拟模型服务验证 Java 管道、模型请求、工具权限、流式回复和跨进程会话恢复。设置页的「测试连接」可验证实际账号。打包目录已包含 Java 运行时，使用者可以直接启动。Git 追踪源码和锁文件。
