# AgentScope Lite Progress

Updated: 2026-11-16

## Completed

- Phase 0 baseline and source provenance.
- Phase 1 application layout and Maven aggregator.
- First Phase 2 slice: local `jharness-agent-core` with the AgentScope message
  and content model.

## Current Module State

- `apps/backend` still uses the upstream AgentScope artifacts.
- `libs/agent-core` builds independently and is not yet on the backend runtime
  classpath.
- Package names remain unchanged to preserve serialization compatibility.
- The imported message slice includes 35 main files and 10 test classes.

## Verification Baseline

- `mvn -B -T1C clean verify`
- `npm test`
- `npm run build:ui`
- `npm run package:win`

## Next Slice

The next core slice should add the event and tool contracts needed by the ReAct
loop. Before backend cutover, agent-core must contain, at minimum:

- agent/event contracts;
- tool registration and invocation contracts;
- model request contracts;
- middleware contracts;
- permission contracts;
- the ReAct loop and cancellation path.

Backend cutover is intentionally blocked until the local harness module can
provide the behavior currently imported from `agentscope-harness`.

