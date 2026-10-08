# Tool catalog, access declarations and execution admission

`AgentTool` is the assembled descriptor: input parameters/schema, target-effect flags (`isReadOnly`, `isDestructive`, `isConcurrencySafe`), and the required `access` contract. The access contract records the descriptor's origin, resident/deferred exposure, declared resource reads/writes, and the common `ToolResult` output envelope. Output payload variants and execution outcomes live in the existing result contracts; the catalog does not claim that arbitrary external output is schema validated.

## Responsibilities

| Layer | Decision | Cannot establish |
| --- | --- | --- |
| Registry / MCP catalog | Input shape, described effects, resources, provenance, discovery exposure | User consent or a filesystem/network sandbox |
| Model request builder | Mode, capability profile, allowlist, disabled tools, loaded MCP schemas | Permission to invoke a name merely because it was exposed |
| Argument validator | Required fields, shape and supported constraints | Whether a syntactically valid operation is authorized |
| Permission pipeline | Explicit deny, invocation approval, run/session grants, trusted native semantics | That an external server's annotation is true |
| Execution lifecycle | Current catalog and policy before approval and again after approval/pause | Retroactive cancellation of an already performed effect |
| Executor / host adapter | Actual filesystem, process, network or native-app operation under its capability boundary | Transactionality or isolation beyond the adapter's implementation |

Built-in resource declarations are exhaustive in `packages/tools/src/toolAccess.ts`; construction rejects an undeclared tool instead of assigning a permissive default. Scope identifies the relevant resource binding: workspace paths, profile memory, run state, host process/native surfaces, or external/unknown effects. The executor's actual capability profile determines permitted path access. Declarations are descriptive inputs for audit and policy design, not a replacement for runtime path/symlink checks or OS isolation. Shell commands and delegated work keep unknown effects explicit. Read-only flags refer to the target operation: session bookkeeping, logging and result retention can still occur.

## Trust in MCP metadata

Remote `tools/list` is projected onto known metadata fields. Its `readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint` and any forged `hostPolicy` do not grant execution privileges. Unknown external effects are non-read-only, destructive/unknown, and non-concurrent by default. They remain discoverable/callable in an appropriately authorized vibe run; annotation alone cannot admit them to plan/read-only runs.

Trusted host code may provide an independent `HostToolPolicy` when registering a local adapter. FluxAgent's browser and computer definitions do this explicitly. The client copies this policy; remote discovery and plugin manifests do not populate it. A borrowed child connection retains provenance and still dispatches through the parent's current selection/catalog checks. The standalone kernel does not import the private desktop implementation.

Host resource declarations are conservative effect bounds, not proof that every listed effect occurs on each call. Browser uploads explicitly read a workspace path; viewport and computer observations can write screenshots/evidence into host-managed storage. Those retained observation artifacts are declared separately from target-page/application mutation. Native actions may have unknown external effects. Their approval and system-specific enforcement remain in the native host.

Names are not proof of origin. `browser__observe` and `computer__observe` receive native approval semantics only when their descriptor is host-authored. An external tool using either name follows external MCP approval. Grant keys separate host and external identities; native group grants cannot authorize external namesakes. Native high-impact computer actions remain one-shot.

## Revocation

An explicit matching deny rule precedes existing run/session grants, full approval policy and otherwise silent native observation. Glob rules treat server-name punctuation literally. The engine validates current allowlists/disabled tools/mode and explicit denies again after waiting for approval or pause, before execution or joining an in-flight read. Losing the connection or selection prevents admission. The MCP client independently verifies that a direct call remains in its enabled catalog and validates its input schema before invoking a handler. The client is a transport/host adapter, not a replacement for the engine's user-approval pipeline.

This closes the observed approval-wait race. It does not promise to revoke an operation already dispatched to another process/service, recover a remote side effect, or make arbitrary host-supplied policy truthful. Process cancellation, external outcome verification and OS containment retain their separate lifecycle responsibilities.

## Surface-size decisions

No resident tool is removed or deferred without evidence that the replacement preserves legitimate tasks. The following overlaps remain intentional pending paired task evaluation:

| Group | Distinct entry points retained | Reason |
| --- | --- | --- |
| File mutation | write, whole-file replace, exact snippet, multi-edit, patch, delete | Different preconditions, atomicity and partial-result contracts |
| Reading/search | ranged/full preview with byte continuation, path/content search, saved web sources, saved tool output | Different budgets, pagination and stable-source behavior |
| Processes | launch, read, write, list, kill | Live process identity and lifecycle cannot be replaced by a fresh command |
| Tasks/children | create/update/list/dependencies; spawn/message/follow-up/read/wait/close/cancel/detach | Work state, child identity, waiting and ownership are different operations |
| Interaction | ask, notification, workflow surface, skill activation | Different blocking and host-UI contracts |

Mode, explicit task allowlist, disabled tools and capability profile select the current catalog; provider adapters preserve that selected set. Provider-specific model/tool capability evolution is separate. The only removed code in this change is an unused semantic label for the no-longer-published `capabilities__request` facade; an external tool of that name receives normal external-tool approval.

Tests cover forged annotations/host policies, native-name spoofing, independent native policies, grants versus explicit denial, approval-wait revocation, direct client admission, child borrowing and catalog coverage. Fixture request size is not real task performance. Installed desktop, OS enforcement, live models and remote services require their own evidence.
