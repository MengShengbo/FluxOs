# @fluxos/contracts

`toolAccess` exports the current tool provenance, exposure/resource declarations, host policy and permission context. Every assembled `AgentTool` includes its access contract. See [tool access](../../docs/architecture/tool-access.md).

Browser-safe Agent, event, state and tool contracts.

Use the declared package exports. Source belongs to this package; do not import sibling source or build directories. See [package architecture](../../docs/architecture/packages.md) for ownership and dependency rules.

The `testing/workExecutionFixture` export provides typed, browser-safe execution conformance data shared by kernel normalization and product persistence/replay tests. It creates independent current `WorkExecutionSnapshot` and `WorkExecutionUpdate` values; it does not adapt or migrate retired task-tree event formats. When execution contracts change, update this fixture and run both repositories' execution tests.

## Tool outcomes

The `toolResultData` export defines process/patch/task receipts and `toolResultExecutionStatus`. Tool payload text is never a failure discriminator: a successful result can start with `Error:`. `isError`, `errorKind`, process facts and interruption metadata determine the outcome. Canonical persistence, presentation and model requests retain the same facts and attachments, including failed results.

`ToolRecovery` records acknowledged effects (`none`, `committed`, `partial`, `unknown`) and a conditional retry requirement. `after_inspection` is required when effects may already exist; none of these values authorize automatic replay. Host recovery guidance is separate from the original output and subject to privacy filtering. Cancellation keeps any settled output intact, including an empty payload.

`TaskMutationReceipt` contains actual task snapshots and indexed failures, including execution/notification failures after a mutation. Rehydration restores these snapshots; it never creates skipped batch entries by replaying the input arguments. A receipt acknowledges observed state, not durable storage or semantic task completion.

`ToolResult.outputSource` describes an ephemeral output snapshot with UTF-16 ranges and expiry. Its metadata survives canonical replay; the in-memory source itself does not. Reading an expired/restored reference fails explicitly. `RetrievalResult.byteRange` records exact UTF-8 file byte ranges and a required continuation version independently of line numbers. Model adapters expose both forms as structured metadata, alongside the bounded output.


Workspace search contracts expose `nextCursor`, `SearchSnapshot` and typed `SearchIncompleteReason` values through executor pages and `RetrievalResult`. Captured results are immutable, bounded and explicitly stale after later workspace changes; pagination metadata survives canonical history, model requests and UI projection. A stored cursor is not a durable capability: new executors reject old cursors and callers must rerun the query to refresh.


`CodeNavigationRequest` / `CodeNavigationResult` define explicit semantic operations, 1-based UTF-16 ranges, exclusive ends, canonical workspace identity, source/project versions, unsupported-language fallback and scoped completeness. Navigation results flow through `RetrievalResult.navigation` and resources with columns, typed compiler diagnostics, symbol names and read/write-reference facts. They must not be reduced to unqualified empty results when analysis is unsupported or incomplete.
