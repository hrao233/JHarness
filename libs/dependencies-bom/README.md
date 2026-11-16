# JHarness Dependencies BOM

This BOM fixes the third-party dependency versions used by the local JHarness
runtime modules. Product modules import it from the root Maven aggregator so
`agent-core`, `agent-harness`, `model-openai` and `apps/backend` resolve the
same versions.

The BOM does not include or import AgentScope's published runtime artifacts.
JHarness builds those runtime capabilities from the source modules under
`libs/`.
