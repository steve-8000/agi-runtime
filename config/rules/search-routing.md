---
description: Route semantic discovery, cross-file impact and live code semantics through lazy-intel.
agents: [main, scout, reviewer, advisor]
---

# Code intelligence routing

The first relevant discovery call for a semantic or cross-component question is `code_intel`, even when the request names one file. Preserve the user's behavior, relationships and constraints in the query; guessed filenames are supplementary anchors. A current, sufficient earlier result satisfies this requirement.

| Need | Route |
|---|---|
| Known path, literal, identifier, regex or exhaustive occurrences | Native exact search |
| Unknown location/wording, behavior or rationale grounded in code | `search` |
| Architecture, dependencies, lifecycle or data/control flow | `architecture` |
| Blast radius of a symbol/contract change | `impact` |
| Live definition or symbol details | `symbol` |
| Callers/usages or concrete implementations | `references` / `implementations` |
| Focused live file diagnostics | `diagnostics` |
| Genuinely ambiguous intelligence question | `auto` |

For a shared contract change, use the applicable impact/reference operation before editing; do not run every row as a checklist. Graph/LSP results do not establish historical intent or exhaustive coverage by themselves: check current source, exact occurrences, tests or Git history as the question requires.

## Inputs and evidence

Always set `root` to the actual project's canonical absolute path, not the MCP process directory. Use the registered schema and server validation as the current input contract; no schema/status preflight is required for ordinary calls. `impact` needs `symbol`; `references`/`implementations` need `symbol` and `relativePath`; `diagnostics` needs `relativePath` and, with the currently documented server validation, a focused `query` or `symbol`.

Keep `freshness=auto`; use `strict` only for a concrete freshness concern. Do not pass `embedding` for an ordinary query. A bounded, current source snippet is already-read evidence. Open more source only for missing detail, freshness or completeness. Empty references are not proof of no callers; inspect project configuration such as jsconfig/tsconfig and use exact search to check coverage.

## Failure and recovery

A missing/degraded capability, unsupported language or demonstrably insufficient result permits focused native fallback, with material limitations reported. Do not silently replace working semantic discovery with broad grep or repeated file opening. Do not repeat nearly identical queries without new evidence.

Use `status`, `sync`, `reindex` or `repair` only for an observed index/backend problem or an explicit maintenance request, through `code_intel`. Do not run standalone backend MCPs, manual index CLIs or another auto-index extension. Keep successful backends usable during partial failure. Authorization failures are not permission to change allowed roots. Never index private OMP state or Sharpshooter banks.
