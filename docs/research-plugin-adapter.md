# Research tool adapter and DSH interoperability

## Implemented in this MVP

`src/research/pluginAdapter.ts` is an explicit, typed boundary around an existing
Hadamard `AgentToolDefinition`. `adaptResearchPluginTool({ plugin, tool })` returns
another definition with the same name, input schema, input validation hooks,
permission callbacks, aliases, cancellation behavior and scheduling classifiers.
It does not mark an unknown tool read-only or grant plugin trust.

The wrapped result is `{ value, evidence }`. Evidence includes a versioned schema,
the declared plugin ID/version/adapter, tool name, run and optional tool-use ID,
and SHA-256 hashes of the JSON input and output. Object keys are sorted before
hashing; array order is preserved. Only finite, acyclic, lossless JSON is accepted.
The underlying output schema is checked before wrapping, and the result is
snapshotted so retained tool references cannot mutate it afterward. Errors and
cancellation reject rather than producing success evidence.

Every envelope is marked `trust: "untrusted"`. These fields establish correlation
and content identity, not scientific validity, verified package identity, a paper
citation, or permission to follow instructions embedded in tool data. A consumer
must explicitly map relevant observations into the research run's evidence ledger;
the adapter does not append to the ledger or validate a claim automatically.

`createResearchTextStatsTool()` is a deterministic offline example. It counts
Unicode code points, UTF-8 bytes and text lines, and hashes caller-supplied text.
The input is capped at 65,536 JavaScript string code units. Empty text has zero
lines; a trailing line break starts an empty final line. This tool does not read
files, fetch URLs, call a model, or run research experiments. It is an embedding
example and is not automatically added to every agent's tool catalog.

## Permissions and registration

Register the returned definition through the existing agent `tools` collection
or another existing local-tool registration path. Native conversation execution
uses `src/runtime/conversationToolExecutor.ts` and its shared tool-policy pipeline.
CodeAct/PTC uses `src/codeact/hostRpcDispatcher.ts`, forwarding nested calls to that
executor when available and retaining the existing permission decision in its
standalone fallback. Permission denial still prevents execution. The wrapper
passes through the original context, progress callback, sandbox context and
turn-control callbacks.

Calling a definition's `execute()` directly, including in a unit test, does not
run the permission pipeline. The adapter is not an alternative permission engine
or an isolation boundary. Supplied code must already be reviewed and registered
through the appropriate trust path. It can have any effects its underlying tool
has; wrapping a network tool does not make it local or private.

The envelope intentionally replaces the original model-facing serializer with
JSON. Tools requiring image/audio content blocks or non-JSON outputs need a
separate explicit projection before adopting this boundary. The original
`isResultTruncated` callback is applied to `value`.

## Existing integration seams and their limits

- DSH-style behavior already present in this repository includes the Hadamard-owned
  contribution host, tool policy pipeline, bounded ordered tool scheduling,
  CodeAct/PTC host dispatch, typed SDK projection, and deferred-context/turn-conclude
  forwarding. See `src/contrib/contributionHost.ts`,
  `src/runtime/toolPolicyPipeline.ts`, `src/runtime/conversationToolBatch.ts`, and
  `src/codeact/`. These are Hadamard implementations, not a Cordis runtime.
- A DSH tool can use this research boundary only after an explicit shim implements
  the existing Hadamard `AgentToolDefinition` contract and its honest permission
  classifiers. `adapter: "explicit-tool"` records this integration choice; it is
  not evidence of automatic DSH package compatibility.
- Existing MCP discovery and invocation live in
  `src/mcp/connectionManager.ts`. External MCP results are resolved-tool adapters,
  not this local-tool definition. This MVP does not implicitly convert MCP tools,
  start servers, install packages, or weaken their package provenance/trust.
- Skills remain prompt/discovery integration (`HadamardSkillDefinition` in
  `src/types.ts`). Skill+MCP bundles retain the separate package-local path and
  trust boundaries described in [ADR-014](adr/ADR-014-skill-mcp-plugin-bundles.md).
  Skill content is not executable tool evidence by itself.
- ACP remains the session/protocol surface in `src/acp/`. Its existing permission
  bridge maps Hadamard asks to client permission requests. This adapter adds no ACP
  method or transport and does not bypass that bridge.

## Remaining work

Automatic DSH/Cordis package loading, dependency/service injection compatibility,
plugin lifecycle emulation, MCP-to-research evidence projection, binary artifact
projection, additional reviewed scientific tools, UI plugin management and
third-party end-to-end compatibility tests are not implemented here. They require
separate design, capability/trust review, and integration tests. No claim of
universal plugin compatibility is made.

## Verification

Run `npm test -- tests/research-plugin-adapter.spec.ts` after installing the
repository's normal development dependencies. Tests cover the ordinary local
adapter and CodeAct denial path, preservation of tool metadata and context,
lossless JSON, output validation, cancellation, failure propagation, deterministic
hashing/snapshotting, and the bounded builtin. No API keys or external research
uploads are used.
