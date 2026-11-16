# JHarness Agent Core

This module is the local, lightweight agent core.

The first imported slice contains the AgentScope message/content model and its
minimal state/JSON/tool-exception dependencies. Package names remain
`io.agentscope.core.*` during migration so persisted messages and downstream
code stay compatible.

The exact upstream snapshot is recorded in
`docs/upstream/agentscope-provenance.md`.

Subsequent slices will add events, tools, middleware and the ReAct loop.
