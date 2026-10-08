# MCP discovery and request schemas

The connection catalog, host policy, and loaded request schemas have distinct responsibilities:

1. `McpClient.getAllTools()` exposes connected tools whose local server is selected for the current run. Disconnected and unselected servers are absent.
2. `AgentEngine.availableMcpTools()` applies disabled tools, the run allowlist, and the current mode/capability restrictions. Search filters this set **before** ranking and top-k, so a denied candidate cannot suppress an allowed match.
3. `AgentEngine.modelMcpTools()` intersects the available set with the in-memory loaded names. Only that intersection enters Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses requests.

An engine starts with no loaded MCP schemas. `tool_search` adds its matching candidates; `enableMcpServerTools` explicitly loads the permitted tools from a selected, connected server. Replacing the client clears the loaded set. Before each request, unavailable names are removed. Re-enabling a previously removed tool requires discovery or explicit activation again. Schemas are sorted by tool name independently of registration/search order. Stable schema sets preserve the same request tools; changing the set also changes the applicable request cache fingerprint. This is a local fingerprint invariant, not a measured upstream cache hit rate.

Loading is a context optimization, **not authorization**. A known tool name does not need to be loaded to reach dispatch checks; dispatch still validates current selection, disabled/allowed policy, arguments and execution permissions. Search does not authorize a side effect. Host integrations must not use the loaded set as their security policy. Read-only/concurrency privileges now come from independent host declarations; remote annotations remain untrusted hints. See [tool access](tool-access.md) for origin, resource, approval and revocation boundaries.

## Lexical retrieval

The scorer uses tool/server names, descriptions, server instructions and input-schema metadata, with IDF-weighted lexical overlap. A small, inspectable alias table covers search, email, calendar, screenshot, browser, repository and issue terminology in English and Chinese. Explicit Han aliases are normalized before ICU word segmentation to avoid splitting known terms. Unknown vocabulary is not translated. Ties use deterministic tool-name order; limits are bounded to 1–20.

This is not semantic intent matching. For example, a catalog containing only `create_event` may return it for a query asking to read a calendar or calculate calendar cost. The search result explicitly tells the model to verify descriptions and schemas and refine weak matches. No vector index, semantic confidence score, or success-rate guarantee is implied.

## Reproducible validation

`packages/extensions/src/mcp/__fixtures__/toolSearch.json` contains 8 synthetic tools and 22 queries: 17 supported queries and 5 unsupported queries. The initial fixed-corpus comparison raised supported top-1 hits from 10/17 to 17/17, while unsupported queries returning a candidate increased from 1/5 to 2/5. Both results matter; the corpus does not estimate real-world task accuracy.

`packages/agent-runtime/src/mcpDiscovery.test.ts` captures actual serialized Engine requests through a fixture stream adapter for all three protocols. Its 50-tool catalog verifies 0 schemas before search, 1 after a specific match, and 50 after explicit activation; it also covers selection revocation, client replacement, disconnection, ordering and policy-before-top-k. Setting `FLUXAGENT_DISCOVERY_METRICS_DIR` to an existing output directory writes protocol-specific schema character/UTF-8 byte counts and hashes from those captured requests. These are synthetic request-size measurements, not tokens, cost, latency, installed application results, or live-model outcomes.
