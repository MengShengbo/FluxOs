# Tool discovery and stable model requests

FluxAgent exposes a small resident tool surface to the model and keeps the full permitted catalog available through discovery. This is a host-managed path shared by Anthropic Messages, OpenAI Chat Completions and OpenAI Responses. It does not send provider-native `defer_loading`, `tool_reference` or `tool_search_output` fields.

## Request and execution path

1. The registry classifies built-in tools as resident or deferred. `getResidentToolsForMode()` supplies the resident definitions in stable registry order. Mode, capability profile, explicit allowlist and disabled tools still constrain availability.
2. The resident `tool_search` searches the permitted built-in catalog together with connected, selected MCP tools. It returns exact tool names, descriptions and input schemas in the ordinary tool result. The result is appended to the conversation; discovered definitions are not inserted into the request's initial `tools` array.
3. The model invokes a discovered operation with `call_tool({ name, arguments_json })`, where `arguments_json` is a JSON-encoded object matching the discovered schema. The envelope cannot invoke either discovery tool recursively.
4. Before creating the assistant turn, the engine decodes the envelope into the actual target name and arguments. The target therefore enters normal scheduling, approval, operation identity, receipts and presentation. The original envelope is retained as `modelInvocation` so the provider sees the model's actual call name and arguments on later requests.
5. Dispatch resolves the current target definition and validates its arguments and current permissions. Discovery neither grants approval nor permits a revoked or unknown operation. The existing execution lifecycle checks remain responsible for filesystem, process, MCP and native-host effects.

A malformed envelope is a validation failure. A missing target, removed connection, changed selection or changed permission is handled by the current execution boundary; there is no fallback to an old name or a different operation. The underlying `TaskManager.createTask()` service is independent of the model-facing task creation tool, which accepts one or more tasks through `create_tasks`.

## Prefix and wire identity

Loading another schema changes the conversation suffix rather than the resident tool definitions. Discovery order and MCP catalog growth therefore do not by themselves reorder or enlarge the initial tool surface. The ordinary provider serializers receive that stable resident surface; no provider-native discovery support is assumed from a custom base URL or compatible gateway.

The runtime's effective target identity and the model's invocation identity serve different purposes. The former drives host policy, execution and user-visible results. The latter preserves the original function call and its matching result on the provider wire, including after durable replay. Saving only the expanded target would claim that the model had called a function that was never offered in its initial tool definitions.

This reduces a known source of prefix changes; it does not guarantee a cache hit. Mode changes, explicit restrictions, system content, conversation compaction and provider routing can still affect the reusable prefix. Measure the actual serialized request and upstream usage. Report request-size reductions, prefix equality and real cache reads separately; the implementation alone does not establish token savings, latency, cost or installed-application behavior. See [model cache diagnostics](model-cache.md).

## Retrieval boundary

Search uses inspectable lexical metadata matching with curated terminology aliases, not a vector index or an additional model call. Results are candidates rather than semantic confidence scores. Inspect the description and required parameters; refine weak matches with an exact tool name, provider terminology or another query. An empty result does not prove that a capability is unavailable.

The complete catalog and execution admission remain separate from model exposure. Deferring a schema does not disable its host implementation, and knowing a tool name does not authorize its effects. See [tool access](tool-access.md) and [MCP discovery](mcp-discovery.md).

`read_file` supports explicit line limits and byte continuation. Task creation uses `create_tasks`, including a one-item array for a single task. Current fixtures and replay tests use these same interfaces.

## Verification scope

Registry, envelope decoding, execution and provider replay tests establish local contracts. Request-capture fixtures can compare resident definition bytes and the placement of discovered schemas. Upstream cache-hit rates require real provider usage observations; desktop packaging and visible use require their own acceptance. None follows from passing a source-level test alone.
