# Harness Architecture Landscape

Date: 2026-11-16

This document records the architectural patterns reviewed for JHarness. It is
input to design decisions, not a command to copy another project.

[Hermes and Pi capability inventory](hermes-pi-capabilities.md) traces the
features in the local snapshots to product entry points, implementations and
test cases. It also maps the findings to the JHarness roadmap.

## AgentScope Java

Role: Java reference for core/harness separation.

Sources:

- `D:\agentscope-java-main\agentscope-java-main\agentscope-core`
- `D:\agentscope-java-main\agentscope-java-main\agentscope-harness`

Observed structure:

- ReAct agent, events, messages, tools, middleware, permission, state and
  session;
- harness adds workspace, context, filesystem, sandbox, memory, compaction,
  skill, subagent, team, gateway and channel;
- extension implementations are spread across separate Maven modules.

Adopt:

- Java 17 engineering and Reactor semantics;
- event/message/tool contracts;
- permission and approval safety model;
- workspace and session concepts;
- optional capability boundaries.

Do not copy wholesale:

- all vendor extension modules;
- the complete HarnessAgent builder before feature pruning;
- all optional dependencies into the default shaded jar.

## Hermes Agent

Repository: `D:\Memory\hermes\hermes-agent`

License: MIT.

Observed structure:

- a single `AIAgent` core serves CLI, gateway, ACP, batch and API entry points;
- SQLite `state.db` stores sessions and messages with WAL and FTS;
- long-term facts live in files and external memory providers;
- prompt assembly is split into stable, context, volatile and per-call layers;
- plugin surfaces include tools, hooks, context engines, memory providers,
  model providers, channels and UI resources;
- plugin manifests declare tools/hooks/capabilities and use additive
  compatibility rules.

Adopt:

- entry-point-independent agent runtime;
- separation of transcript facts, long-term memory and provider state;
- prompt cache stability;
- capability-aware plugin discovery;
- plugin dependency ordering and compatibility fixtures;
- profile/workspace isolation.

Do not copy wholesale:

- the monolithic mixin/facade style;
- the large channel and memory-provider catalog;
- import-time execution without a trust model in an untrusted project.

## DeepSeek Harness (DSH)

Location: `D:\dsh`

This is a packaged Electron application. It is an architecture reference only;
the runtime package has no clear source license declaration, so code must not
be reused.

Observed structure:

- Electron shell with ACP/JSON-RPC-facing runtime;
- 287 private runtime packages;
- modules split across agent, agent-loop, LLM, tools, session, storage,
  sandbox, subagent, plugin manager, client UI and protocol;
- session persistence, query and projection are separate concerns;
- session formats have explicit version migrations;
- compression, image offload and tool-result pruning are separate plugins;
- permission presets and sandbox policy are first-class modules.

Adopt:

- capability-level package boundaries;
- session persistence/query/projection separation;
- explicit session format versions and migrations;
- plugin host and inventory as a first-class subsystem;
- least-authority policy abstractions.

Do not copy:

- the 287-package granularity;
- packaged implementation code;
- the entire UI plugin graph in the first release.

## Pi

Repository: `D:\pi-main`

License: MIT.

Observed package sizes:

| Package | Source files | Source lines |
|---|---:|---:|
| pi-agent-core | 9 | 2,548 |
| pi-durable | 111 | 33,980 |
| chord | 316 | 61,439 |
| pi-coding-agent | 369 | 85,688 |
| pi-ai | 273 | 30,559 |
| pi-codemode | 20 | 2,917 |
| pi-mcp | 29 | 4,382 |
| pi-schema | 44 | 4,317 |
| pi-telemetry | 8 | 1,473 |
| pi-tui | 46 | 17,865 |

Observed structure:

- agent core handles turns, events, tools, steering and follow-up;
- durable runtime owns persisted conversations, tasks, signals, checkpoints,
  recovery, forking and subagent ownership;
- coding agent is a large product layer with extensions, package manager,
  commands, providers and UI;
- chord provides cross-process object runtime, documents, storage, links,
  plugins and hot reload;
- sessions are append-only JSONL event trees;
- compaction is an appended entry, not a mutation of raw history;
- extensions have a rich event/context API and persist custom state through
  session entries;
- project-local executable extensions require project trust.

Adopt:

- minimal agent core;
- separate durable harness;
- steering versus follow-up queues;
- append-only session tree and context projection;
- extension API with explicit event ordering and capability context;
- provided host API, not bundled host packages;
- project trust before project plugin loading.

Do not copy wholesale:

- the full 80k+ line coding-agent product;
- the Chord UI/runtime stack;
- the complete extension surface in the first release;
- Pi's assumption that OS/container isolation is external; JHarness retains
  explicit permissions and approvals.

## Shared Lessons

1. Keep the agent loop smaller than the operational harness.
2. Persist facts before claiming durable completion.
3. Separate raw history from model-visible context.
4. Make compaction append-only and replayable.
5. Use stable IDs and idempotent request IDs.
6. Model approvals and human input as durable signals where recovery matters.
7. Define plugin capabilities, not one universal plugin interface.
8. Keep vendor integrations outside the default distribution.
9. Version persisted formats and plugin wire contracts.
10. Treat project content and executable plugins as untrusted input.

