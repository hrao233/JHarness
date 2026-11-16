# JHarness Agent Harness

This module provides the operational envelope around `agent-core`:

- workspace and project filesystem access;
- append-only session logs and transcript recovery;
- context assembly and compaction;
- long-term memory and daily memory maintenance;
- skills and skill repositories;
- subagents, gateway and channel abstractions;
- approval continuation contracts;
- the capability-scoped plugin host.

Vendor channel adapters, cloud storage, remote sandboxes and external protocol
adapters are intentionally not shipped in this module. They can be supplied
through the plugin API without changing `agent-core`.

The plugin host is in `io.agentscope.harness.plugin`. It supports model
providers, tools, middleware, context sources, skill repositories, session
stores, agent state stores, filesystems and gateway channels. Project-local
executable plugins are not discovered automatically; the host must load only
an application-controlled and trusted classloader.
