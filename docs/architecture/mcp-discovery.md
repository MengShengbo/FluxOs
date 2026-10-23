# MCP discovery and host catalog

The connection catalog, host policy, and model exposure have distinct responsibilities:

1. `McpClient.getAllTools()` exposes connected tools whose local server is selected for the current run. Disconnected and unselected servers are absent.
2. `AgentEngine.availableMcpTools()` applies disabled tools, the run allowlist, and the current mode/capability restrictions. Search filters this set **before** ranking and top-k, so a denied candidate cannot suppress an allowed match.
3. `AgentEngine.toolDiscoveryCatalog()` combines the available MCP definitions with permitted built-in definitions. `tool_search` returns matching schemas in a normal tool result; the model invokes the target through the resident `call_tool` envelope. Connected MCP schemas do not enter the initial `tools` array.

Discovery does not maintain an expanding set of MCP schemas in the request prefix. New results extend conversation history instead. Replacing the client, selection changes and disconnections affect the current searchable and executable catalog. The stable resident surface and the preservation of the model's original invocation are described in [tool discovery](tool-discovery.md). Prefix stability is a local request property, not a measured upstream cache hit rate.

Discovery is a context optimization, **not authorization**. A known target name still reaches dispatch checks; dispatch validates current selection, disabled/allowed policy, arguments and execution permissions. Search does not authorize a side effect. Host integrations must not use prior search results as their security policy. Read-only/concurrency privileges come from independent host declarations; remote annotations remain untrusted hints. See [tool access](tool-access.md) for origin, resource, approval and revocation boundaries.

## Lexical retrieval

The scorer uses tool/server names, descriptions, server instructions and input-schema metadata, with IDF-weighted lexical overlap. A small, inspectable alias table covers search, email, calendar, screenshot, browser, repository and issue terminology in English and Chinese. Explicit Han aliases are normalized before ICU word segmentation to avoid splitting known terms. Unknown vocabulary is not translated. Ties use deterministic tool-name order; the scorer bounds limits to 1–20, while the model-facing `tool_search` endpoint accepts 1–8 (default 5).

This is not semantic intent matching. For example, a catalog containing only `create_event` may return it for a query asking to read a calendar or calculate calendar cost. The search result explicitly tells the model to verify descriptions and schemas and refine weak matches. No vector index, semantic confidence score, or success-rate guarantee is implied.

## Reproducible validation

`packages/extensions/src/mcp/__fixtures__/toolSearch.json` contains 8 synthetic tools and 22 queries: 17 supported queries and 5 unsupported queries. The initial fixed-corpus comparison raised supported top-1 hits from 10/17 to 17/17, while unsupported queries returning a candidate increased from 1/5 to 2/5. Both results matter; the corpus does not estimate real-world task accuracy.

Engine request-capture tests exercise discovery and invocation through fixture adapters for all three protocols, alongside selection revocation, client replacement, disconnection, ordering and policy-before-top-k. Interpret definition character/UTF-8 byte counts and hashes as synthetic request-size measurements. They are not token, cost, latency, installed application or live-model outcomes, and do not establish upstream cache hits.
