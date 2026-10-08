# FluxOs package architecture

FluxOs is the independent MIT kernel. Its ten public packages use `@fluxos/*` declared exports. The sibling private FluxAgent product owns workbench assembly, DOM rendering, remote control, Electron and native adapters; no core package depends on a private product package. The assistant's public name is FluxAgent.

## Ownership

| Package | Responsibility |
| --- | --- |
| `contracts` | Shared types, events, current tool/execution/model contracts and browser-safe pure rules |
| `platform` | Node files, processes, user paths, locks, atomic publication and host model-configuration storage |
| `models` | Model configuration rules, discovery, provider requests and streaming protocol adapters |
| `tools` | Tool registry, argument validation, executor, permissions, file/search/memory/process implementations |
| `extensions` | MCP connections, Skills and plugin lifecycle through kernel interfaces |
| `agent-runtime` | AgentEngine, turn execution, context, child sessions, tool scheduling and run state |
| `conversations` | Canonical event normalization, durable journals, replay and conversation repositories |
| `profiles` | Profile isolation, workspace bindings and archive/import transactions |
| `automations` | Definitions, schedule/claim/lease, checkpoints, recovery and delivery facts |
| `presentation` | Deterministic projections of current events and snapshots, without DOM ownership |

`contracts` and `presentation` are browser-safe; Node and native implementations stay behind the appropriate runtime interfaces. Cross-package imports, including type-only imports, use declared exports. Sibling `src`/`dist` deep imports and dependency cycles are rejected by `npm run verify`.

## Direct domain dependencies

The following table reflects package manifests. It excludes external npm dependencies; implementation imports are independently checked by `scripts/verify-architecture.mjs`.

| Package | Direct domain dependencies |
| --- | --- |
| `@fluxos/contracts` | none |
| `@fluxos/platform` | none |
| `@fluxos/models` | `@fluxos/contracts`, `@fluxos/platform` |
| `@fluxos/tools` | `@fluxos/contracts`, `@fluxos/platform` |
| `@fluxos/extensions` | `@fluxos/contracts`, `@fluxos/platform` |
| `@fluxos/automations` | `@fluxos/contracts`, `@fluxos/platform` |
| `@fluxos/presentation` | `@fluxos/contracts` |
| `@fluxos/agent-runtime` | `@fluxos/contracts`, `@fluxos/extensions`, `@fluxos/models`, `@fluxos/platform`, `@fluxos/presentation`, `@fluxos/tools` |
| `@fluxos/conversations` | `@fluxos/agent-runtime`, `@fluxos/contracts`, `@fluxos/models`, `@fluxos/platform`, `@fluxos/presentation` |
| `@fluxos/profiles` | `@fluxos/conversations`, `@fluxos/platform` |

## Runtime and persistence boundaries

The consumer assembles an Agent runtime and injects tool/native adapters. AgentEngine prepares context and provider requests, validates and dispatches tools, receives model/tool results and emits current execution facts. Tool return, process exit and semantic task acceptance are separate states. Provider protocol adaptation is current interoperability, not an old application-schema migration.

The conversation layer normalizes and durably commits canonical facts before advancing committed projections. A persistence failure is not a successful commit. Consumers project current events through `presentation`; UI and host lifecycle ownership remain outside the kernel. Patch operations expose committed, pending and unknown effects rather than pretending that a multi-file operation is a filesystem transaction. Crash recovery and transaction integrity continue to be tested even while old format readers are removed.

## Versions and validation

The root and ten public manifests currently use `1.0.1`; package versions describe APIs, while a consumer's pinned Git revision describes its source baseline. A dirty working tree can build different code at the same HEAD and version. Record HEAD, dirty state and source/build digests with validation; package metadata alone is not release provenance.

Run `npm ci`, `npm run verify`, `npm run build`, `npm run type-check`, `npm test` from the core repository. Build cleans package output, so do not run it concurrently with tests that consume `dist`. `npm run pack:core` verifies dry-run packaging. Kernel tests and compiled API checks do not certify a private desktop installation or real external services.

Before product launch, update current APIs, data and fixtures directly; do not add development-era aliases, fallback readers, dual writes, compatibility facades or runtime migrations. The public repository can be cloned, documented, built and checked without private product source. See the [repository README](../../README.md) and [contribution policy](../../CONTRIBUTING.md).
