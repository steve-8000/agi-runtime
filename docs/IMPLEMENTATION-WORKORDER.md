# Runtime maintenance contract

This is a reference for changes to the runtime, not a startup reading list. Host execution and search policy live in [AGENTS.md](../config/AGENTS.md); operation details live in [search-routing.md](../config/rules/search-routing.md). Do not copy their bodies here.

## Preserve ownership

OMP owns model selection, the native tool loop, sessions and approvals. Main owns source changes and integration; other agents remain read-only. Sharpshooter owns durable memory. lazy-intel owns `code_intel` and derived indexes. Runtime owns observation, uncertain outcomes and recovery assistance, not a second orchestrator or completion judge.

Use current source and relevant intelligence to determine the affected contract. For shared API/symbol changes, inspect applicable references/impact before editing. Do not add a service, queue, model loop, recall obligation or execution budget to solve a policy problem.

## Choose verification by the changed contract

| Change | Relevant verification |
|---|---|
| Policy/rule/document wording | Links, frontmatter, input examples, authority/trigger consistency; [policy scenarios](POLICY-VALIDATION.md) when assessing agent behavior |
| Runtime classification, correlation or journal | Affected cases in `tests/runtime.test.mjs` and `npm run check` |
| Extension events or compaction | Affected cases in `tests/extension.test.mjs`; native SDK compatibility when its contract changes |
| Sharpshooter observation | Affected cases in `tests/memory.test.mjs`; real extraction/consolidation/injection only for a changed integration contract |
| Activation/rollback or probe cleanup | Affected cases in `tests/install.test.mjs` |
| Cross-cutting runtime change/release | Relevant integration suite; existing `upgrade-check` and live probe only when needed and authorized |

These are scope choices, not a sequence every task must execute. Follow [implementation-loop.md](../config/rules/implementation-loop.md) for review and escalation. Do not run paid live probes merely because documentation changed.

Update affected documentation and integrity metadata. Preserve historical evidence; never relabel an old run as validation of a new policy. Only remove scratch resources whose ownership is established; a child-reported memory-bank path is not deletion authority.
