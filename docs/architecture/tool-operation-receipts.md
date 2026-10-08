# Write ownership and operation receipts

The agent lifecycle coordinates side-effectful tool invocations and records their admission and settlement. These mechanisms complement permission checks, per-file publication receipts, task receipts and process termination receipts. They do not replace those mechanisms or make a tool call a transaction.

## Admission and ownership

Every caller resolves and validates its tool, obtains current approval, waits through pauses and revalidates current policy before inspecting a receipt or dispatching. Fixed read tools retain the signal-scoped in-flight ledger: only concurrent physical reads share work, and completed reads are not cached indefinitely.

An admitted writer claims its entire resource set synchronously or receives a conflict result without dispatch. Independent known file paths can proceed concurrently. Canonical ancestor/descendant paths overlap, including repository operations against files beneath the repository. Parent symlinks are resolved for not-yet-created files. macOS and Windows paths use conservative case folding; macOS also normalizes Unicode, so a case-sensitive volume can receive unnecessary but safe conflicts.

Commands, patches and unknown external effects use a coarse host domain. There is no command-prefix side-effect inference. Trusted built-in `kill_terminal`, `cancel_agent` and `close_agent` use a separate target-control domain, so a running writer cannot prevent its cancellation. These controls still require current permissions and target ownership. Session-local state has a session domain; profile memory uses its configured root when available. Exceptions and cancellations release the invocation's ownership after settlement. Locks protect cooperating invocations in one host runtime process. They do not coordinate separate workers/processes, user programs or remote systems, and they end when a background-launch invocation returns. Existing file locks still guard individual file publications. There is no claim of atomic multi-file editing.

## Stable identity and persistence

`createAgentRuntime` installs `ToolOperationStore` under `<runtimeStorageRoot>/tool-operations`. Desktop runtimes pass their overlay storage root. Direct `AgentEngine` consumers must inject the operation service to receive restart protection; without it they receive process-local write coordination only.

Before publishing a live assistant turn, the host binds each call to its original session, assistant-turn and call identity. This `operationIdentity` survives canonical ID normalization, transcript projection and runtime rehydration, including a tool proposal with no corresponding tool result. It is host metadata, not a model parameter. Tool results retain the same identity. Canonical tool items, live/incremental activity projections, transcript indexes, work/task activity links, child transcript/recovery, context-file preservation, compaction facts and restored result associations use that full identity, so a provider reusing one call ID in later turns cannot overwrite an earlier receipt or display another call's result. A new assistant turn or call ID is a new operation; equal arguments do not silently consume an intentional new request.

The journal key is SHA-256 of the identity tuple. A separate SHA-256 fingerprint covers the tool name and stable arguments. Reusing an identity with different input is rejected. Files contain only hashes, an owner token, times and enum-valued outcome/effect facts; raw arguments, outputs, task contents, credentials and screenshots are not journaled here. Existing canonical privacy rules still apply to transcripts.

1. Exclusively create and sync an intent before dispatch. Failure means no dispatch.
2. Execute once under the acquired ownership and settle its typed result, including interruption or failure.
3. Verify the intent owner and atomically publish a separate settlement file. Existing settlements cannot be overwritten.
4. Any existing identity blocks dispatch. A settled receipt reports its historical effect facts. An unresolved intent, unreadable/corrupt record or an orphan settlement requires inspection.

Exclusive intent creation also rejects the same identity across independent processes sharing the journal directory. That limited claim is separate from the process-local resource coordinator: different identities in separate processes do not share a write lock.

POSIX intent and settlement files and newly created directories are synced. Windows follows the platform helper's file-sync semantics without directory fsync. Filesystem, device or journal deletion failures remain outside the guarantee. The journal and external side effects cannot participate in one atomic commit; this is not global exactly-once execution.

## Recovery and presentation

A replay is returned as a blocked invocation with a receipt and inspection-before-retry guidance, never as a newly successful execution or a cached claim that current state is unchanged. A successful process exit also does not establish its filesystem/network effects. Unknown external effects remain `unknown`, even when transport settlement was persisted.

If settlement persistence fails, the live result retains its original output and acknowledged patch/task/file/process facts, while its operation receipt explicitly reports unconfirmed persistence. The retained intent makes a later invocation uncertain and prevents blind replay. Observer failures after settlement cannot remove the stored receipt. Authorization is still checked before an invocation can inspect an earlier receipt.

The receipt crosses canonical storage, restored sessions and all three model protocols; the desktop displays blocked replay and unconfirmed persistence separately from the original evidence. Recovery must inspect current file/process/external state. A deliberate follow-up uses a new operation identity after that inspection; no automatic retry, rollback or remote compensation is performed. Catalog activation (`tool_search`, `use_skill`) rebuilds ephemeral state and is not journaled as a durable external effect. The three built-in cancellation controls also use their existing process/task termination receipts instead of the mutation journal, keeping authorized stop available when that journal is unwritable. External tools cannot acquire this exception through their names or annotations.

Receipts are retained without automatic eviction: deleting an old receipt to save space would allow its identity to execute again. Operators must treat explicit runtime-data deletion as deleting replay protection too. The journal is local trusted runtime state, not tamper-proof storage against a process with host filesystem access.

## Verification limits

Local tests exercise real file writes, independent lifecycle owners, symlink aliases, abrupt child termination after a side effect, same-identity contention between Node processes, corrupt/orphan journals, failed settlement writes and observer failures. Canonical tests deliberately change presentation IDs and omit tool results before reopening. Product integration runs actual Engine request serialization for Chat Completions, Responses and Messages, plus isolated Electron DOM checks. These fixtures do not establish installed/signed-app, real-account, paid-model or Windows/Linux-device acceptance.
