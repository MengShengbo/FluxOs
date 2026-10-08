# @fluxos/models

## Explicit custom patch transport

`modelCapabilities.responsesCustomTools: true` opts a configured endpoint into Responses custom tools. Discovery preserves an explicit boolean `capabilities.responses_custom_tools`; ordinary `tools: true`, provider/model names and unknown metadata do not imply support. The capability is protocol-specific: Chat Completions and Anthropic Messages keep JSON function/tool-use inputs, including when this flag is set.

For Responses with this capability, an enabled `apply_patch` is advertised as `type: custom`, `format: { type: text }`. Raw patch input is normalized into the same canonical `{patch: string}` arguments before the existing tool validation, permissions and execution. Request history maps a valid single-string patch call and its matching output to custom call items; malformed historical arguments retain their exact function-call envelope instead of being dropped or repaired. Disabled/read-only patch tools are never advertised as custom tools.

The stream adapter handles custom input delta/done, output-item and completed-response events, retaining call-id aliases. Unknown custom tools, unfinished input and input over the stream limit fail explicitly. No truncated custom input is admitted for execution. Chat/Anthropic or unspecified capabilities continue using the existing JSON representation. Current custom-enabled requests use `parallel_tool_calls: false`; this conservative transport choice trades batched model calls for simpler interoperability and is separate from host scheduling.

Tests use local provider-shaped fixtures and real temporary files, not live paid providers. Raw text saves JSON argument escaping, but HTTP request/response envelopes still encode JSON; byte counts are not token, latency or task-success benchmarks. Upstream endpoint/model/account support must be verified independently before enabling the flag.

Model configuration, credentials, discovery and streaming protocols.

Use the declared package exports. Source belongs to this package; do not import sibling source or build directories. See [package architecture](../../docs/architecture/packages.md) for ownership and dependency rules.
