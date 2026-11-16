# JHarness Agent Core

This module is JHarness's local, provider-independent agent runtime. It contains
the complete imported AgentScope Core surface needed by JHarness:

- the ReAct loop and agent lifecycle;
- messages, content blocks and events;
- model contracts and transport contracts;
- tools, tool groups, permissions and execution;
- middleware, hooks, interruption and cancellation;
- sessions, state stores and structured tool results;
- workspace, skills, RAG and tracing contracts.

Package names remain `io.agentscope.core.*` so persisted state, event payloads
and downstream imports stay compatible with the reference implementation.

The exact upstream snapshot is recorded in
`docs/upstream/agentscope-provenance.md`.

Provider-specific model code belongs in `libs/model-openai`. Operational
workspace, memory, context and session behavior belongs in
`libs/agent-harness`.
