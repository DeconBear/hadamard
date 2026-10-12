# Research-agent MVP

Hadamard's research workflow is opt-in. It reuses the existing CodeAct Python
kernel service and tool permission pipeline; it does not introduce another
agent engine. No model API key is needed for the offline example.

## Project panel

Open a workspace, then **Project → Research**. The panel shows the canonical
experiment/run ledger, active/failed/passed counts, run details, stdout/stderr,
criterion observations, artifact hashes and immutable manifest provenance.

1. Expand **New experiment manifest (JSON)**. The initial example evaluates five
   points of a quadratic and checks both the minimum and sample count.
2. **Pin manifest and probe environment** captures code, Git provenance when
   available, input bytes/digests, lockfile digests, Python/package metadata,
   parameters, seeds, acceptance criteria and budgets. It runs only the bounded
   metadata probe, after confirmation. Disabled CodeAct allows an unpinned
   preview; enable CodeAct and create a new manifest before executing it.
3. **Run pinned experiment** requires confirmation. A fresh run ID, working
   directory and Python namespace are created. The panel polls persisted states;
   it does not infer progress from assistant text.
4. Open a run for logs, metrics, artifacts and validation details. Cancel active
   work or explicitly rerun a settled experiment. Reruns retain the original
   manifest and receive a new ID and a `rerunOf` link.

The panel preserves a draft while navigating, ignores stale workspace responses,
prevents double-click submission and rejects duplicate execution request keys.
Execution is serialized per workspace with a bounded queue. A process restart
marks previously unfinished records blocked; it never silently reruns them.

## Manifest contract

```json
{
  "title": "Quadratic scan",
  "objective": "Check a known minimum over five values",
  "code": "import json, pathlib\nout = pathlib.Path('artifacts')\nout.mkdir(exist_ok=True)\nvalues = [(x - 2) ** 2 for x in RESEARCH_PARAMETERS['xs']]\n(out / 'metrics.json').write_text(json.dumps({'minimum': min(values)}))",
  "inputs": [],
  "parameters": { "xs": [0, 1, 2, 3, 4] },
  "seeds": [7],
  "acceptanceCriteria": [
    { "id": "minimum", "kind": "numeric", "artifact": "metrics.json", "path": "minimum", "expected": 0, "tolerance": 0 }
  ],
  "budget": { "timeoutMs": 10000, "maxArtifactBytes": 1048576, "maxRuns": 10 }
}
```

`inputs` are workspace-relative regular files, snapshotted when the manifest is
pinned and staged under `inputs/<path>`. Python receives `RESEARCH_PARAMETERS`
and `RESEARCH_SEEDS`; Python `random` is seeded with the first seed. Explicitly
loop over additional seeds and seed other libraries in your experiment code.
Outputs belong under `artifacts/`. Numeric criteria read
finite JSON numbers by dot-separated field path with absolute tolerances. File
criteria check size and optionally a precommitted SHA-256 digest. Criteria cannot
be edited after a manifest is created; changing them requires a new manifest.

Records are stored in the workspace's `.hadamard/research/v1/` ledger. Collected
artifacts are copied to content-addressed blobs after validation. These records
are local; this feature does not upload research data or send telemetry.

## SDK and agent integration

```ts
import {
  CodeActService, ResearchService, createResearchTools, settleResearchGoalRun,
} from 'actoviq-agent-sdk';

const codeAct = new CodeActService({
  enabled: true, backend: 'process', securityMode: 'trusted',
});
const selectedGoal = await selectedGoalService.read();
if (!selectedGoal) throw new Error('Select a Goal before associating evidence.');
const selectedGoalCreatedAt = selectedGoal.createdAt;
const research = new ResearchService(workspacePath, {
  codeAct,
  // Optional: bind an already selected Goal explicitly. Do not discover/change
  // the current Goal when an asynchronous run later finishes.
  onRunSettled: run => settleResearchGoalRun(selectedGoalService, run, selectedGoalCreatedAt),
});
await research.initialize();
const tools = createResearchTools(research);
// Register tools with the existing Hadamard runtime/tool catalog. Do not call
// tool.execute directly to bypass the permission pipeline.
// ...
await research.close();
await codeAct.close();
```

`ResearchList` and `ResearchStatus` are read-only. `ResearchCreate` and
`ResearchRun` explicitly ask the existing permission pipeline for execution
approval and deny plan mode. `ResearchCancel` uses ordinary mutation permissions.
Tools are opt-in; the GUI does not inject them into every existing chat.

Successful lifecycle/tool calls are operational results, not validated research
progress. The narrow research Goal hook adds evidence only after independent
precommitted criteria pass, with an idempotent receipt. It does not automatically
complete a Goal or mark its work items done. Ordinary non-research Goal behavior
is retained. The GUI ledger is workspace-scoped and does not guess which Goal a
run belongs to; SDK callers explicitly associate a Goal through the hook.

## Guarantees and limits

- Command success and validation are separate. Exceptions, timeout, cancellation,
  missing/unsafe files, environment drift and criterion failures remain visible.
- Reproducibility here means a retained manifest, staged input/code bytes,
  recorded environment and explicit fresh rerun. It is not a proof that arbitrary
  code is deterministic. Network services, native libraries, GPUs, OS state,
  unlisted external files and unseeded libraries may still affect results.
- **Process mode is trusted-only, not a sandbox.** Python can access the host
  with the user's process permissions. Path checks protect artifact/input intake;
  they do not make malicious experiment code safe. Enforce/container settings
  retain CodeAct's existing isolation policy. No host tools are exposed to
  experiments by default.
- The wall-clock budget includes staging/probing/execution/validation. The
  artifact-byte budget limits the collected artifact tree, not every disk write
  arbitrary Python could perform. This MVP does not add a hard host memory, CPU,
  network or total-disk quota; existing container limits remain separate.
- Input snapshots and environment fingerprints are checked; lockfile snapshots
  do not provision environments or install dependencies. Runtime drift blocks a
  run rather than silently changing the manifest.
- The complete artifact tree is bounded, rejects unsafe entries and is ingested with lineage. The panel
  displays logs/metadata as text and never renders artifact HTML or executes it.
- A passed criterion is not scientific truth, peer review, novelty, statistical
  significance or an independent replication. Domain-specific validators and
  stronger statistical acceptance suites are future work.
- Plugin support is an explicit local tool adapter, not an arbitrary Cordis
  plugin loader. See [the adapter contract](research-plugin-adapter.md).

Out of scope: autonomous model-driven experiment design, scheduler automation,
distributed workers, environment provisioning, paper writing, arbitrary plugin
installation and automatic Goal completion. Nothing is merged, deployed or
released by using this workflow.
