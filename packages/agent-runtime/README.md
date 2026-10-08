# @fluxos/agent-runtime

Agent execution, context, subagents and lifecycle orchestration.

Use the declared package exports. Source belongs to this package; do not import sibling source or build directories. See [package architecture](../../docs/architecture/packages.md) for ownership and dependency rules.

MCP request schemas are loaded by discovery or explicit server activation and filtered again before each request. See [MCP discovery](../../docs/architecture/mcp-discovery.md); loading never substitutes for dispatch authorization.

## Tool result lifecycle

Command outcomes use the contracts package's typed process union and invocation-specific expected exit codes. Retry guidance, failure tracking, context handoff, child-agent evidence and work activities evaluate `toolResultExecutionStatus` rather than assuming `isError === false` means the command succeeded. A background launch is a completed call with a running process; polling settles process activity separately.

Session rehydration and canonical conversation persistence retain all typed result details. A cancellation after dispatch preserves already captured output/process facts and adds the interruption; it cannot retroactively prove a background process stopped. Task acceptance remains a separate semantic decision. This does not replace the current run-conclusion policy with a test or artifact verifier.

Dispatch failures explicitly return `isError` and `errorKind`; returned strings are successful payloads, regardless of their wording. The model receives a structured outcome and the original output on every supported protocol. Retry guidance does not add a synthetic user turn or rewrite external evidence.

Task mutation dispatch captures changed nodes if a manager or host notification fails after commit. `TaskNotificationError` stops the remainder of a batch, and the result retains affected parent/child snapshots with `partial` effects and inspection-before-retry guidance. Notification errors remain visible. This bookkeeping serializes the current task tree for each mutation; it is not a transaction manager or a guarantee that all observers consumed the event.

Side-effectful invocations also use process-local write ownership. The runtime factory installs persistent operation intents and settlement receipts; direct Engine consumers must inject the service for restart protection. Original host operation identities survive canonical ID normalization. Replays are blocked for inspection, not returned as fresh successes. See [write ownership and operation receipts](../../docs/architecture/tool-operation-receipts.md) for scope, failure behavior and retention limits.
