# AgentScope Source Provenance

Captured: 2026-11-16

Reference root:

`D:\agentscope-java-main\agentscope-java-main`

The local reference copy has no `.git` directory, so a commit ID cannot be
derived from the working tree. This document pins the exact snapshot by
declared version, file counts, line counts and aggregate SHA-256 digests.

## Declared Version

- Maven revision: `2.1.0-SNAPSHOT`
- Java target: 17
- License: Apache License 2.0

## Source Size

| Module | Main Java files | Main Java lines | Test classes | Test lines |
|---|---:|---:|---:|---:|
| `agentscope-core` | 364 | 64,112 | 235 | 68,157 |
| `agentscope-harness` | 295 | 53,529 | 188 | 43,859 |
| `agentscope-extensions-model-openai` | 53 | 8,785 | 45 | 13,561 |

## Aggregate Digests

The digest covers every file in the selected scope. Entries are sorted by
relative path and hashed as:

```text
<relative/path>:<sha256-of-file>
```

The final aggregate is the SHA-256 of the UTF-8 manifest.

| Module | Scope | Files | Aggregate SHA-256 |
|---|---|---:|---|
| `agentscope-core` | main | 1,702 | `1d0835cd14a12349076554396207d1d8f7e72d43d38f934d671d7c000d69f154` |
| `agentscope-core` | test | 271 | `003ea450a7c10d11871de886ba7b3b98dc8ba0eaa8b0e8f4cacb8d8e99dcab9a` |
| `agentscope-core` | all | 1,973 | `3275dae800d10848870fff9989d7f1f23a770b672d79623f4a79e2a4da2b61dd` |
| `agentscope-harness` | main | 1,116 | `1364515c4eb7bf4805fc7500d68033a02de610bd3dc2ef500b6370ef18a25f7f` |
| `agentscope-harness` | test | 196 | `3bb296d542334d6077f41d6c6ce2a9727dae920b3690dc420b6200c620f32f56` |
| `agentscope-harness` | all | 1,312 | `fe222b5d1d5742935adb17a2f32aa585bcc1ebd02bd45e5614afa1e1545f8154` |
| `agentscope-extensions-model-openai` | main | 244 | `2e2cc6b55586c843d9b86a8f534d26653e08445db4b837f45a0b44964e74b93f` |
| `agentscope-extensions-model-openai` | test | 45 | `b745559e8ab419690e52c963eaebd050521a68e40160fde5fc168c3a0b9d1c01` |
| `agentscope-extensions-model-openai` | all | 289 | `3a10daec8cc9cfd68b5f8a25c64ee42799e8db6b1779950d0b82bd2cce588750` |

## Import Rules

- Do not import from a different AgentScope snapshot without updating this
  document and re-running the digest.
- Preserve Apache 2.0 license headers and add required notices.
- Preserve resources that affect runtime behavior, including service
  registrations and session schemas.
- Do not rename packages during the first import.
- Add a local patch log when imported source diverges from this snapshot.

## Local Patch Log

- `agentscope-extensions-model-openai`: excluded the Kimi, GLM and MiniMax
  provider/formatter implementations. JHarness ships the OpenAI-compatible
  provider and DeepSeek options only; other providers remain available through
  the plugin model-provider contract.

