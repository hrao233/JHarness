# ADR 0003: Capability Plugin API

Status: Accepted

Date: 2026-11-16

## Context

AgentScope's extension ecosystem is large and heterogeneous. Copying every
extension interface would preserve coupling without giving JHarness a coherent
plugin model.

## Decision

Define a small plugin host with capability-specific contracts.

Initial capabilities:

- model provider;
- tool provider;
- middleware;
- context source;
- skill repository;
- session store;
- agent state store;
- filesystem/execution;
- gateway channel.

Plugins provide a manifest with id, version, API version, capabilities,
dependencies and settings schema. Contracts evolve additively. Wire formats and
persisted state receive explicit schema versions.

The host loads plugins deterministically. Project-local executable plugins are
denied until the project is trusted. The first implementation may load trusted
plugins in process; process isolation can be added later without changing the
capability interfaces.

## Consequences

- Vendor connectors can be added without changing agent-core.
- Single-select providers such as session storage are distinct from
  multi-select providers such as tools.
- Host API classes must be provided by the host and excluded from plugin
  shaded jars.
- A test-only plugin is required to prove that every slot is replaceable.

