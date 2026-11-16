# AgentScope Lite Progress

Updated: 2026-11-16

This page records the AgentScope Lite migration and its verification results.
The [JHarness maturity roadmap](../roadmap/jharness.md) tracks product
capabilities and delivery milestones beyond the migration.

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

### Product milestone: durable task control plane

- Routed desktop `durable` conversations through `AgentSession` instead of
  transient streaming runs while preserving the existing approval modes.
- Persisted task identity, turn identity, pending approvals and interruption
  state in the session log; reopening the backend reconstructs the same task.
- Added same-session queueing for later submissions and steering for a running
  durable task without creating a second turn.
- Added cross-session task projection for the desktop task center and a narrow
  IPC surface for listing, steering, queueing, resuming and cancelling tasks.
- Allowed the Electron main process to track multiple active runs so queued work
  can start while another run or session remains active.
- Added end-to-end coverage for task-center projection, restart recovery,
  same-session queueing and steering context delivery.
- Added explicit reconciliation for uncertain tool outcomes. The task card
  collects one success/error decision per unresolved call, writes the result
  into the session projection, and resumes from the repaired state.
- Added immutable session branching from a selected message. A branch stores a
  clean `AgentState` baseline plus a source marker instead of copying open runs,
  so the new conversation can continue immediately.
- Added a context inspector over the latest `request/prepared` event, including
  model, message previews, tool names, `HARNESS_CONTEXT` items, compaction count,
  checkpoints and pending interactions.
- Added packaged-GUI smoke coverage for opening the context panel and loading its
  empty state.
- Added packaged task-recovery smoke: a bundled Java backend creates a durable
  task with a pending file approval, exits, and the packaged Electron app must
  render the same task with its approval action.
- Added Markdown and raw-event JSON export through a native save dialog. Export
  content is generated in Java with a 16 MiB safety bound and written only by the
  Electron main process.
- Added branch-source navigation and export controls to the context panel.
- Added a 1,200-message synthetic long-session test that measures context
  inspection plus Markdown/JSON export against a five-second local budget.
- Added a legacy v1 migration fixture that is loaded into the current journal,
  inspected, exported and branched. Added Chinese and English session-search
  expectations, including branch results.
- Replaced linear cross-session message scanning with a rebuildable SQLite FTS5
  projection. Latin words are lower-cased tokens; CJK runs use adjacent
  character bigrams so phrase-like Chinese recall works without a native
  tokenizer extension. Session head sequences skip unchanged reindexing.
- Added FTS tests for Chinese, English, filenames and a 5,000-message query
  budget. The append-only session journal remains the recovery source.
- Connected the existing process host to the desktop as an explicit external
  tool-plugin manager. Install, enable/disable, lazy start, tool invocation,
  diagnostics and uninstall are implemented without scanning project folders.
- Added a process-plugin integration test and an E2E conversation that installs a
  Node.js echo plugin, exposes it to the model, invokes it and verifies the tool
  result reaches the next model request.
- Added an optional Edge/Chrome DevTools Protocol plugin with status, tab listing,
  HTTP(S) navigation, visible-text extraction and Bing search. An E2E fixture
  validates its HTTP DevTools protocol against a local mock endpoint.
- Extended the browser plugin with CDP-backed selector click, form fill,
  selector wait, cache-bypassing reload and history back/forward. The E2E mock
  now handles the WebSocket handshake and masked command frames directly, so the
  plugin is tested without adding a WebSocket dependency.
- Added conflict-aware file checkpoints around normal and durable project writes.
  Each checkpoint stores bounded before/after snapshots and tool status. The
  desktop can inspect diffs and restore one file only when its current hash
  matches the post-write snapshot.
- Added checkpoint tests for edits, created-file deletion, paths outside the
  project, user edits after a checkpoint, durable task writes and packaged UI
  empty state.
- Added `TaskReportStore` and a desktop task-report view keyed by session/run.
  Reports merge the latest `todo_write` plan, shell receipts, delivered artifacts
  and file checkpoints.
- Shell results now carry structured `ToolExecutionDetails` and persisted command
  receipts with exit code, outcome, duration and bounded output. The same evidence
  path is used after suspending and resuming a durable command approval.
- Registered `deliver_artifact` against a project-rooted, sandboxed filesystem.
  Artifact bytes are stored under JHarness application data with plain-name,
  session ownership and 32 MiB bounds. The desktop can open a registered artifact.
- Extended E2E coverage for task plans, artifact delivery and opening metadata,
  command evidence, checkpoint/report correlation and durable command resume.
- Added whole-run file restore. Successful checkpoints are grouped by path, the
  earliest before snapshot and latest after hash form the restore contract, and
  every target is preflighted before the first mutation. Any later user edit
  blocks the complete change set.
- Persisted `RUNNING`, `RESTORED` and `ERROR` change-set audit records. A partial
  filesystem failure rolls applied files back to their post-run snapshots in
  reverse order. Checkpoint timestamps are monotonic so repeated writes to one
  path retain the correct order across restarts.
- Added unit and E2E coverage for repeated writes, created-file deletion,
  conflict-wide refusal and successful three-file restore.
- Added desktop-managed isolated Git worktrees. A current-HEAD checkout is
  created on a `jharness/*` branch under app data and registered as a separate
  project scope. Source dirty-file counts are shown but uncommitted changes are
  not copied.
- Worktree status tracks dirty files and commits ahead of the recorded base.
  Removal refuses dirty trees and unmerged commits unless the user explicitly
  forces cleanup. The manager sweeps failed creation, worktree admin entries and
  its own branch.
- Fixed the packaged Electron allowlist to include the new worktree manager and
  added packaged-GUI coverage for opening the isolation panel.
- Added isolated-worktree review and integration. Review shows bounded patch,
  diff stat and commit subjects; integration requires clean source and worktree
  checkouts, merges with `--no-commit --no-ff`, leaves staged changes for user
  inspection and aborts on conflict.
- Added a CLI second entry over the same backend protocol and workspace. It reads
  desktop settings, reuses or creates a project/session identity, streams text
  and tools, supports interactive approvals, NDJSON events and durable-suspend
  exit status.
- Added packaged CLI support through `jharness-cli.cmd` and Electron's
  `ELECTRON_RUN_AS_NODE` mode. The CLI test validates the same desktop session
  and workspace path, and packaged smoke verifies the launcher.
- Added `acceptance_write` and host-authorized shell-exit verification. Criteria
  begin as `PENDING`; only a user-selected command receipt from the same run can
  produce `PASSED`, `FAILED` or `UNKNOWN`. The report retains command identity,
  expected code, verifier ID, timestamp and reason.
- Verification refuses truncated output, unknown outcomes and mismatched
  exit/outcome evidence. Rewriting the criterion list preserves the status and ID
  of unchanged text instead of silently resetting a verified criterion.

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

- `mvn -B -T1C clean verify`: 5088 tests, 0 failures, 0 errors, 56 skipped;
- `npm test`: 7 tests, 0 failures;
- `npm run build:ui`: success;
- `npm run package:win`: success, including `PACKAGED_GUI_SMOKE_OK`;
- shaded backend JAR: 22,579,167 bytes (21.5 MiB).

The cross-process Node test launches the shaded backend JAR with the bundled
Java runtime and verifies model requests, tool permissions, streaming events,
workspace edits, memory, web approval, cancellation and session recovery.
It also verifies plan persistence, command receipts, artifact metadata and bytes,
checkpoint/report correlation, and command approval across a durable resume.

## Follow-up Work

- M2 now includes uncertain tool-result reconciliation and packaged recovery of
  a pending approval task. The remaining increment is packaged fault injection
  while an approved tool is executing and when its outcome is unknown.
- M3 now exposes recent model context, message-level session branching, source
  navigation, Markdown/JSON export, a v1 migration sample and a rebuildable
  SQLite FTS5 recall index with CJK bigram tokens. A branch records its source
  and begins from a clean state baseline. A broader migration corpus and scored
  recall quality evaluation remain.
- M5 now has desktop integration for process-isolated tool plugins. Capability-
  level RPC, public SDK packaging, model/context/storage plugin slots and upgrade
  compatibility remain.
- M7 now has a CLI second entry for one-shot tasks and doctor diagnostics. The
  CLI can create a desktop-visible session and use interactive or JSON output.
  Channel adapters and concurrent multi-entry settings coordination remain.
- M4 now has a reviewable project-work slice: task plans, command/test receipts,
  artifacts, file checkpoints, diffs, safe per-file restore and guarded
  whole-run restore, isolated Git worktrees and deterministic shell-evidence
  verification, plus user-reviewed worktree integration. Broader semantic
  verifiers and automated commit authoring remain.
- M6 now configures the JDK 17 `jlink` compression flag and runs Node integration
  tests after building the bundled runtime. Clean Windows runner and release
  verification remain pending.

The [maturity roadmap](../roadmap/jharness.md) defines the product acceptance
scenarios and the next delivery increments.
