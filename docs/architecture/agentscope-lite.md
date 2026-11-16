# AgentScope Lite 架构与迁移规划

The local runtime migration is implemented through Phase 5. Phase 6 results
and follow-up work are recorded in the [migration progress](../progress/agentscope-lite.md).

Product development beyond the migration follows the [JHarness maturity roadmap](../roadmap/jharness.md).

Date: 2026-11-16

## 1. Goal

JHarness is the product. AgentScope Java is the reference implementation for a
Java agent harness, not a runtime dependency that must remain forever.

The target is a lightweight, locally focused Java harness with:

- a small agent core;
- a focused harness runtime for sessions, context, workspace, memory, tools,
  approvals and skills;
- stable plugin seams for future capabilities;
- no vendor integration modules in the default distribution;
- the same user-visible JHarness behavior during migration.

The migration must not mix source extraction, repository restructuring and
behavioral rewrites in one change.

## 2. Initial Desktop Delivery Scope

JHarness is a Windows desktop project assistant. The first release of
AgentScope Lite is optimized for a single local user and a local project
workspace.

In scope:

- ReAct reasoning and tool execution;
- streaming text, reasoning and tool events;
- local project tools and command approval;
- session logs, transcript projection and recovery;
- workspace guidance, project memory and compaction;
- project skills;
- an OpenAI-compatible model adapter with DeepSeek-specific options;
- stable extension contracts for tools, middleware, context sources, model
  providers, session storage, filesystem/execution and channels.

Out of scope for the first release:

- Feishu, DingTalk, WeCom, Weixin, GitHub and GitLab channel adapters;
- vendor model providers other than the built-in OpenAI-compatible adapter;
- Redis, MySQL, PostgreSQL, MongoDB, OSS, COS and Nacos storage backends;
- AgentRun, Daytona, E2B and Kubernetes sandbox implementations;
- A2A, AG-UI and other external protocol adapters;
- Spring Boot starters, service/control-plane, Studio, Training and Judge;
- automatic loading of executable plugins from an opened project.

The abstractions needed to add those capabilities later remain part of the
plugin API. The [maturity roadmap](../roadmap/jharness.md) tracks optional
integrations beyond the initial desktop delivery.

## 3. Target Repository Layout

```text
JHarness/
├─ apps/
│  ├─ backend/                  Product process and JSON-line protocol
│  ├─ desktop/                  Electron main/preload and process lifecycle
│  └─ ui/                       React renderer
├─ libs/
│  ├─ agent-core/               Agent loop, messages, events, tools, middleware
│  ├─ agent-harness/            Sessions, context, workspace, memory, skills
│  ├─ model-openai/             Built-in OpenAI-compatible model adapter
│  └─ dependencies-bom/         Local third-party dependency versions
├─ packaging/windows/           jlink and Windows packaging scripts
├─ scripts/                     Build, test and development entry points
├─ tests/
│  ├─ e2e/                      Cross-process product tests
│  ├─ compatibility/            Persisted data and protocol compatibility
│  └─ fixtures/                 Shared test data
├─ docs/
│  ├─ architecture/
│  ├─ decisions/
│  └─ research/
├─ pom.xml                      Maven aggregator
├─ package.json                 Electron/UI build entry point
└─ README.md
```

Generated output must not be committed:

- `build/`
- `dist/`
- `release/`
- `runtime/`
- `**/target/`
- `node_modules/`
- `.idea/`

## 4. Module Responsibilities

### apps/backend

Owns JHarness product behavior:

- desktop JSON-line protocol;
- model setting validation;
- project tools and PowerShell execution;
- approval and review policy;
- project memory facades;
- mapping harness events to desktop events.

It may depend on all local libraries. Libraries must never depend on it.

### apps/desktop

Owns Electron lifecycle only:

- application startup and shutdown;
- window and IPC registration;
- settings and credential protection;
- spawning and supervising the Java backend;
- opening the built UI.

It must not contain agent behavior.

### apps/ui

Owns the React interface:

- conversation rendering;
- composer and attachments;
- memory and project navigation;
- settings and approval dialogs.

It must not access the filesystem directly.

### libs/agent-core

Owns the provider-independent agent runtime:

- agent/turn lifecycle;
- messages and content blocks;
- agent events;
- tool contracts, registry and execution;
- middleware and permission hooks;
- steering/follow-up queues;
- cancellation and terminal reasons.

It must not depend on the harness, product backend or UI.

### libs/agent-harness

Owns the operational envelope around agent-core:

- durable session log and transcript projection;
- context assembly and compaction;
- workspace and local filesystem;
- long-term memory;
- skills;
- approvals that need durable continuation;
- optional sandbox/filesystem/execution abstractions;
- plugin host and capability registry.

It may depend on agent-core only.

### libs/model-openai

Owns exactly one provider family:

- OpenAI-compatible chat completions;
- SSE streaming;
- tool calls;
- image input;
- reasoning effort, service tier and DeepSeek thinking options.

It must not contain Kimi, GLM, MiniMax, Anthropic, Gemini or DashScope
implementations.

## 5. Agent Execution Model

The core execution model is:

```text
submit input
  -> create turn
  -> prepare model request
  -> stream model response
  -> parse text/tool calls
  -> validate and gate tool calls
  -> execute tools
  -> append tool results
  -> decide continue or finish
  -> commit turn
  -> settle run
```

The implementation should learn from Pi's separation of:

- `AgentMessage` used by the durable/session/UI layers;
- provider messages produced only at the model boundary;
- steering input that changes the current run;
- follow-up input that starts later work;
- request preparation immediately before every provider call;
- turn finalization before a run settles.

JHarness keeps AgentScope's permission and approval safety model. Pi does not
provide a built-in security boundary for tool execution and must not be copied
in that area.

### Durable task control plane

Desktop durable conversations use `AgentSession` as the execution boundary.
The session log records the accepted command, turn, run, pending interactions
and terminal status. The backend projects those facts into task views; it does
not maintain a second task database.

The control plane supports:

- one active execution per session with later submissions parked as queued;
- steering input bound to the active turn;
- approval decisions encoded as session responses;
- restart recovery from the committed session prefix;
- cross-session task listing for the desktop task center.

The Electron main process tracks multiple active run IDs because a queued task
can begin after an earlier task settles. The React UI may focus on one run at a
time, but task ownership and ordering remain in Java.

### Session archive and branching

`SessionArchive` provides two read/write views over committed journals:

- context inspection reads the latest `request/prepared` fact and projects the
  model name, message previews, tools, rendered `HARNESS_CONTEXT` items, pending
  interactions, compaction facts and the most recent checkpoint;
- branching creates a new journal with a single `migration/baseline` state built
  from the selected source prefix, followed by a `presentation/hint` source
  marker.

A branch does not copy an unfinished run or wait for the source session to stop.
Keeping only the transcript baseline avoids inheriting stale writer ownership,
inbox commands or active tool state. The source session remains unchanged and
continues to hold the complete raw history.

### External process tools

`ExternalPluginManager` stores only explicitly installed plugin directories and enabled state.
Installation parses `jharness-plugin.json` without launching code. Enabled plugins are started
lazily when a request builds its toolkit.

Each declared tool is registered as a normal Core tool whose implementation sends `tool_call`,
`tool` and `input` over the process host JSON-line protocol. Calls are serialized per host, bounded
by request timeout, and return stderr diagnostics separately from protocol output.
The process boundary limits crashes and protocol interference; it is not an OS sandbox.

### File checkpoints

Every `edit_file` or `create_file` execution captures a checkpoint in the project's JHarness data
workspace:

1. snapshot the target before execution;
2. persist a `RUNNING` checkpoint;
3. execute the already-approved write;
4. snapshot the target again and persist `SUCCESS` or `ERROR`.

The project directory remains the working source. Checkpoints are separate JSON records containing
the relative path, session/run/operation identity and bounded 64 KiB text snapshots. Restore verifies
that the current file hash still equals the checkpoint's post-write hash. A mismatch stops the
restore, preserving edits made after the Agent stopped. Symbolic-link targets and paths outside the
project are rejected.

Whole-run restore groups successful checkpoints by path. For each path, the earliest `before`
snapshot is the restore target and the latest `after` snapshot is the expected current state. The
preview checks every path before the first mutation. Any missing, changed, oversized or type-changed
file is reported as a conflict and blocks the entire run. Repeated writes to one path count as one
file and preserve the original pre-run content.

Before applying a multi-file restore, the backend writes a `RUNNING` change-set record containing
the selected paths. Files are then replaced through same-directory temporary files and atomic
renames where supported. If a later write fails, files already applied are restored to their
recorded post-run snapshots in reverse order. The final audit record becomes `RESTORED` or `ERROR`;
all checkpoints in a restored path group become `RESTORED` so the same change set cannot be replayed.
This is a guarded multi-file operation, not a filesystem-wide atomic transaction.

### Task reports and artifacts

`TaskReportStore` projects durable, user-reviewable evidence for each session/run:

- `todo_write` arguments are validated and stored as the latest full plan revision;
- `run_command` writes a receipt with exit code, producer outcome, duration and bounded output;
- `deliver_artifact` copies a file from the sandboxed project filesystem into the application data
  directory under the owning session/run, recording its source path, size and SHA-256;
- project write checkpoints are merged into the same report by session and run identity.

Plans, command receipts and artifact metadata live under `task-reports/<session>/<run>/` in the JHarness
data workspace. Artifact bytes live under `artifacts/<session>/<run>/<artifact>/`. The source project
is never used as the artifact store. Artifact names are plain file names, contents are capped at
32 MiB, duplicate names require an explicit force replacement, and only metadata-relative paths
owned by the selected session are exposed to Electron.

The report schema is an append-oriented projection, not a second execution log. The session journal
remains authoritative for task and tool state; deleting report projections does not make an
uncertain side effect safe to retry.

### Session search projection

Session recall uses a rebuildable SQLite FTS5 database under the local data
directory. The append-only journals remain authoritative. A per-session committed
head sequence skips reindexing unchanged sessions.

Tokenization is deliberately small and deterministic:

- lower-case Latin words and numbers;
- adjacent character bigrams for contiguous CJK runs;
- a unigram for a one-character CJK query.

Queries combine generated tokens with `AND`, which favors precision for both
English phrases and Chinese substrings. Removing the index only loses query
speed; the next scan recreates it from the journals.

## 6. Session and Context Model

The append-only session log is the source of truth. A database is a query and
projection layer, not a replacement for raw history.

Required properties:

- every session entry has a stable ID;
- entries can reference a parent entry for future branching;
- compaction creates a new entry and never rewrites raw history;
- context edits change only future model-visible context;
- transcript views and export operate on raw entries;
- provider request construction operates on a projection;
- compressed history retains a reference to the first kept entry;
- persisted event schemas are versioned and migrated explicitly.

The first implementation can remain JSON/JSONL-based. A SQLite search
projection can be added without changing the fact source.

## 7. Plugin Model

The first release exposes a small, versioned plugin API. It does not recreate
the complete AgentScope extension ecosystem.

Every plugin declares:

- id;
- version;
- required API version;
- capability list;
- optional dependencies;
- settings schema;
- entry point.

Lifecycle:

```text
discover -> validate -> initialize -> start -> active -> stop
```

Initial capability slots:

| Capability | Multiplicity | Notes |
|---|---|---|
| model provider | multi | Built-in OpenAI-compatible provider is the default |
| tool provider | multi | Includes future MCP/RAG tools |
| middleware | multi | Ordered transformation and observation |
| context source | multi | Read-only request preparation |
| skill repository | multi | Filesystem/classpath first |
| session store | single | Local event log is the default |
| agent state store | single | Local state is the default |
| filesystem / execution | single | Local workspace first |
| gateway channel | multi | Vendor adapters remain external |

Compatibility rules:

- evolve plugin contracts additively;
- version wire formats and persisted schemas, not every callback;
- host-provided APIs are `provided` dependencies, never shaded into plugins;
- no monkeypatching or reflection into private core internals;
- a plugin failure is bounded and reported;
- project-local executable plugins are not loaded until the project is
  explicitly trusted;
- in-process loading is sufficient for the first release; process isolation
  can be added behind the same capability contracts.

## 8. Model Strategy

Ship one model module with a direct factory. ServiceLoader may remain as an
internal registration mechanism, but it must not become a vendor extension
catalog.

The model request layer retains:

- system prompt and transcript projection;
- tool definitions;
- image content;
- response streaming;
- usage and finish reason;
- reasoning content;
- HTTP cancellation and timeout;
- OpenAI-compatible base URL and endpoint path.

The default HTTP transport is JDK `HttpClient`. OkHttp is not required for the
first release.

## 9. Security and Trust

The following are mandatory:

- project file tools remain rooted to the selected project;
- command execution remains explicitly approved when policy requires it;
- write review inputs are treated as untrusted data;
- credentials remain in the desktop secure store;
- project plugins and executable extensions are deny-by-default;
- tool results and workspace files are evidence, not trusted instructions;
- session and plugin state migrations do not weaken path containment.

The first release does not claim that in-process plugins are a security
sandbox. External plugins require a separate process boundary in a later
phase.

## 10. AgentScope Lite Migration Phases

Phase 0–6 document the runtime migration. Product maturity stages are tracked
in the [JHarness maturity roadmap](../roadmap/jharness.md).

### Phase 0: Baseline and version control

Actions:

- create a dedicated feature branch;
- record architecture, research and ADRs;
- record source provenance for any code imported from AgentScope;
- capture current build and test behavior.

Exit criteria:

- plan is committed in `D:\JHarness`;
- existing source and generated output are separated;
- baseline tests pass or known failures are documented.

### Phase 1: Repository and Maven foundation

Actions:

- add the root Maven aggregator;
- move product code under `apps/`;
- move build scripts under `packaging/`;
- update paths in Electron, Vite and tests;
- keep the existing backend jar name during migration.

Exit criteria:

- backend package builds from the new location;
- UI build succeeds;
- Node integration tests execute from the new location;
- Windows packaging paths are updated.

### Phase 2: Agent core extraction

Actions:

- add `libs/agent-core`;
- port the minimal ReAct loop, messages, events, tools, middleware,
  permissions and cancellation behavior;
- retain only tests for the selected behavior;
- keep package names unchanged until behavior is stable.

Exit criteria:

- core builds independently;
- call and stream semantics match the baseline;
- no harness or product dependency appears in core.

### Phase 3: Harness extraction

Actions:

- add `libs/agent-harness`;
- port session log, workspace, local filesystem, context, memory, compaction
  and skills;
- introduce optional interfaces for sandbox, subagent, gateway and channel
  capabilities without shipping vendor implementations.

Exit criteria:

- harness builds against local core;
- persisted sessions remain readable;
- workspace and memory file layout is unchanged;
- core and harness contain no vendor integration dependency.

### Phase 4: Plugin host

Actions:

- define plugin manifests and capability contracts;
- implement deterministic discovery and lifecycle;
- implement multi-select and single-select slots;
- add a test-only plugin that replaces model, tool, middleware, context source
  and session store behavior;
- add project-trust gating for executable plugin locations.

Exit criteria:

- built-ins work without plugins;
- the test plugin can replace each supported capability;
- incompatible or failed plugins do not crash the host;
- no plugin can silently bundle the host API.

### Phase 5: Product cutover

Actions:

- point `apps/backend` at local agent-core, agent-harness and model modules;
- remove upstream Maven dependencies;
- keep a temporary upstream build profile until parity is confirmed;
- update README and development scripts.

Exit criteria:

- no `io.agentscope:*` runtime artifact remains;
- desktop end-to-end tests pass;
- old sessions and memory load without migration;
- shaded jar contents and size are audited.

### Phase 6: Hardening

Actions:

- add SQLite transcript/search projection if needed;
- add durable approval continuation;
- add plugin compatibility fixtures and API drift checks;
- add package-size and startup-time budgets;
- document future optional modules.

Exit criteria:

- full build and Windows packaging pass;
- crash/restart approval behavior is deterministic;
- plugin API tests survive an independent consumer build;
- known gaps are explicit.

## 11. Verification Commands

The exact commands will change during the directory migration, but the target
gates are:

```powershell
mvn -B -T1C clean verify
npm ci
npm test
npm run build:ui
npm run package:win
```

Additional checks:

```powershell
mvn dependency:tree
rg "io\.agentscope:(agentscope-core|agentscope-harness|agentscope-extensions-model-openai)"
jar tf apps/backend/target/jharness-backend.jar
```

## 12. Acceptance Criteria

- JHarness user-visible behavior is preserved during the migration.
- Existing sessions, memory, workspace files and bookmarks remain readable.
- agent-core has no dependency on harness, product backend or UI.
- agent-harness depends only on agent-core and approved third-party libraries.
- vendor extensions are absent from the default dependency graph.
- plugin contracts are versioned and tested with an external fixture.
- project-local executable plugins require trust.
- no source code or planning artifact for this work is written into the
  AgentScope reference repository.

## 13. Known Risks

- Upstream AgentScope source has no Git metadata in the local reference copy;
  provenance must be recorded before importing code.
- Java source is more verbose than the TypeScript and Python references; line
  count comparisons are directional, not direct equivalence.
- HarnessAgent currently wires many optional subsystems; copying it wholesale
  would defeat the lightweight goal.
- Session serialization and package names are compatibility-sensitive.
- Plugin loading can introduce classloader and duplicate-API problems.
- Context compaction can hide information even when raw history remains; task
  state and approvals must survive independently.

