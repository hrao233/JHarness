# ADR 0001: Module Boundaries

Status: Accepted

Date: 2026-11-16

## Context

JHarness currently has one Java backend module that depends on external
AgentScope Core, Harness and OpenAI model artifacts. The repository also mixes
Electron, React, backend, generated output and release artifacts.

## Decision

Use four physical code areas:

- `apps/backend`
- `apps/desktop`
- `apps/ui`
- `libs/agent-core`, `libs/agent-harness`, `libs/model-openai`

Dependency direction is one-way:

```text
apps/backend -> libs/agent-harness -> libs/agent-core
apps/backend -> libs/model-openai  -> libs/agent-core
apps/desktop -> apps/backend/process
apps/ui      -> apps/desktop/ipc
```

`agent-core` must never import harness, app or vendor integration code.

Physical Maven modules remain limited until a real independently versioned
boundary exists. Logical package boundaries do not require one Maven module per
feature.

## Consequences

- The product can replace the upstream AgentScope dependencies without moving
  product code a second time.
- The lightweight runtime can be tested without Electron or React.
- Future optional capabilities can become separate modules without changing
  the core dependency direction.

