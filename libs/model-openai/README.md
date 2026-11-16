# JHarness OpenAI-Compatible Model

This module is the built-in model adapter for JHarness. It supports:

- OpenAI-compatible chat completions;
- SSE streaming;
- tool calling;
- image input;
- reasoning effort and service tier options;
- the DeepSeek thinking options used by the desktop application.

The module intentionally contains no Kimi, GLM, MiniMax, Anthropic, Gemini or
DashScope adaptation. Additional providers belong behind the plugin model
provider contract.
