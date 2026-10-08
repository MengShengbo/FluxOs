# @fluxos/automations

Automation scheduling, persistence, routing and recovery.

Use the declared package exports. Source belongs to this package; do not import sibling source or build directories. See [package architecture](../../docs/architecture/packages.md) for ownership and dependency rules.

## Checkpoint workspace identity

`captureAutomationWorkspaceIdentity` (the `automationCheckpoint` export) hashes file bytes, relative paths, file modes, directory names and symbolic-link targets. Tracked, untracked and Git-ignored workspace files are included; Git HEAD and porcelain status are recorded before and after the scan. An unborn repository is supported. The digest is independent of timestamps; size, inode, mtime and ctime checks detect ordinary concurrent changes during scanning.

Every checkpoint persists `workspaceCoverage`: algorithm, scope, exclusions, resource limits, scanned entry/byte counts and the first incompleteness reason. The current algorithm is `sha256-workspace-content-v1`. Root `.git` metadata is excluded from the content walk: Git objects, config and hooks are **not** covered by this identity. The workspace must be the repository root. Nested repositories/submodules, external or dangling symlinks, symlinks into excluded metadata, special files, read failures and detected concurrent changes make the scan incomplete. Internal symlink targets are covered by the ordinary tree walk, without following directory cycles.

Default synchronous scan limits are 10,000 entries, 64 MiB total file bytes, 16 MiB per file and a 2-second cooperative time budget (also passed to Git subprocesses). Optional limits may be supplied explicitly to the capture function. An individual filesystem operation can exceed the time budget on a stalled filesystem; this is not a hard real-time deadline. No ignored dependency/config directory is silently dropped to make a large workspace appear complete. Exceeding a limit disables automatic recovery and records `budget_exceeded`; a partial digest is never proof that the workspace is unchanged.

This is a bounded observation, not an atomic filesystem snapshot or security boundary. It does not attest to external services, global environment, dependencies outside the workspace, or effects already produced by a tool. Effect classification, stable idempotency keys, frozen permissions, plugin versions and the existing recovery review gates still apply. Unknown or non-idempotent effects require review even when the workspace scan is complete. The current checkpoint format requires coverage; there is no old-format migration or status-only fallback.
