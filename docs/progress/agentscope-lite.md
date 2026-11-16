# AgentScope Lite Progress

Updated: 2026-11-16

## Current State

JHarness now builds and runs from local Java modules. It no longer resolves
AgentScope Core, Harness or model artifacts from Maven at runtime.

```text
apps/backend
  -> libs/agent-harness
  -> libs/model-openai
  -> libs/agent-core

libs/agent-harness -> libs/agent-core
libs/model-openai  -> libs/agent-core
```

The imported package names remain `io.agentscope.*` so persisted state, event
payloads and existing downstream imports stay compatible.

## Completed Phases

### Phase 0: Baseline and provenance

- Created the feature branch `feat/agentscope-lite-foundation`.
- Captured architecture, research, module-boundary and session decisions.
- Recorded the AgentScope source snapshot by version, file count, line count
  and SHA-256 aggregate digest in `docs/upstream/agentscope-provenance.md`.
- Preserved Apache 2.0 headers and recorded every intentional source exclusion.

### Phase 1: Repository foundation

- Moved product code into `apps/backend`, `apps/desktop` and `apps/ui`.
- Moved Windows packaging into `packaging/windows`.
- Added the root Maven aggregator, local dependency BOM and cross-process E2E
  test layout.
- Updated Electron, Vite, tests and packaging paths.

### Phase 2: Agent core

- Added `libs/agent-core` with the complete provider-independent AgentScope
  Core surface used by JHarness.
- Retained the ReAct loop, events, messages, tools, middleware, permissions,
  cancellation, state, sessions, skills, RAG and workspace contracts.
- Core depends on approved third-party libraries only and has no Harness,
  backend, desktop or UI dependency.

### Phase 3: Agent harness

- Added `libs/agent-harness` against the local Core module.
- Retained workspace, local and remote filesystem contracts, session logs,
  transcript recovery, context assembly, compaction, memory, skills, subagents,
  task repositories, gateway and channel abstractions.
- Preserved the existing workspace, memory and session file layouts.
- Kept cloud sandboxes, vendor channels and remote protocol implementations
  out of the default product dependency graph.

### Phase 4: Plugin host

- Added a deterministic, in-process capability host in
  `io.agentscope.harness.plugin`.
- Supported capability slots for model providers, tools, middleware, context
  sources, skill repositories, session stores, agent state stores, filesystems
  and gateway channels.
- Added manifest versioning, dependencies, settings schema, duplicate checks,
  dependency ordering and reverse-order shutdown.
- Added tests that exercise every capability slot, dependency ordering,
  capability declarations, duplicate single-select providers and settings
  schema preservation.
- Project-local executable plugins are not scanned or loaded automatically.
  Callers must provide an application-controlled, trusted classloader.

### Phase 5: Product cutover

- Pointed `apps/backend` at `local.jharness` modules.
- Removed all `io.agentscope:*` Maven runtime dependencies.
- Imported the OpenAI-compatible adapter and DeepSeek options only.
- Excluded Kimi, GLM and MiniMax implementations from the local model module.
- Kept Feishu, DingTalk, WeCom, Weixin, GitHub, GitLab, cloud storage, external
  sandbox and protocol adapters outside the default distribution.
- Preserved the desktop JSON-line protocol and user-visible JHarness behavior.

### Phase 6: Hardening

- Persisted approval requests and decisions in the project workspace.
- Marked approvals left pending after a backend crash as `INTERRUPTED`; restart
  never re-executes an uncertain side effect automatically.
- Added explicit `approvals` and `dismissApproval` protocol operations.
- Added an isolated executable-plugin process host with bounded JSON-line
  requests, stderr diagnostics, shutdown, and explicit working directories.
- Added an independent public-API consumer fixture under `tests/plugin-consumer`.
- Added API-surface drift assertions for capability names and manifest version.
- Added JAR, packaged-directory, and startup-time budget checks.
- Added a Windows verification workflow covering Maven, Node integration,
  packaging, and package budgets.
- Added a v1 session fixture covering the legacy event envelope and message
  payload shape.
- Fixed packaged Electron UI path resolution and added a hidden packaged-GUI
  smoke test that verifies rendered page content.

## Lightweight Runtime

Dependencies that support optional capabilities are marked optional where the
runtime can operate without them:

- MCP SDK;
- OkHttp model transports;
- tree-sitter shell analysis;
- OpenTelemetry tracing;
- Jackson YAML configuration;
- Commons Compress sandbox archives.

SQLite remains a required Harness dependency because the default local session
storage uses it on the normal conversation path.

The shaded backend JAR contains only the local Core, Harness, OpenAI-compatible
model module, JHarness backend and required runtime dependencies.

## Verification

The final verification gate is:

```powershell
mvn -B -T1C clean verify
npm test
npm run build:ui
npm run package:win
```

Last verified on 2026-11-16:

- `mvn -B -T1C clean verify`: 5076 tests, 0 failures, 0 errors;
- `npm test`: 4 tests, 0 failures;
- `npm run build:ui`: success;
- `npm run package:win`: success, including `PACKAGED_GUI_SMOKE_OK`;
- shaded backend JAR: 22,437,472 bytes (21.4 MiB).

The cross-process Node test launches the shaded backend JAR with the bundled
Java runtime and verifies model requests, tool permissions, streaming events,
workspace edits, memory, web approval, cancellation and session recovery.

## Remaining Hardening

The remaining work is capability-level RPC over the process bridge and broader
historical storage migration coverage. The process host currently provides
isolated lifecycle and request transport; Java capability objects are still
registered in-process.
