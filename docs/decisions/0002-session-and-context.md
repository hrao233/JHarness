# ADR 0002: Session Facts and Context Projection

Status: Accepted

Date: 2026-11-16

## Context

Conversation history, model context and user-visible transcript serve different
purposes. Mutating stored messages during compaction makes recovery, audit and
branching fragile.

## Decision

Use an append-only session log as the source of truth.

Required entry types:

- session header;
- message entry;
- model/thinking/configuration change;
- tool execution and result;
- compaction;
- context edit;
- custom plugin state;
- custom model-visible plugin message;
- approval request and decision.

Each branchable entry has a stable ID and optional parent ID. Compaction appends
a summary and a first-kept-entry reference. Context edits append an instruction
to omit or replace an earlier entry in future model projections.

The model request is built from a projection:

```text
raw session tree
  -> active branch
  -> latest applicable compaction
  -> context edits
  -> agent message conversion
  -> provider request
```

## Consequences

- Raw history, export and search remain complete.
- Compaction can be retried or superseded without deleting evidence.
- A future SQLite index is a rebuildable projection.
- Branching and fork support can be added without a schema rewrite.

