---
description: Choose native exact search or lazy-intel code intelligence without duplicating work.
agents: [main, scout, reviewer]
---

# Search routing

- Known identifier, path, literal, error, regex or exhaustive occurrence: native `glob`, `grep`, AST or live LSP semantics. Exact enumeration is authoritative for completeness.
- Unknown wording/location, behavior, architecture, dependencies, call flow, impact or cross-file synthesis: `code_intel` through the single lazy-intel MCP first. Preserve the user's concepts and constraints; choose the explicit operation.
- `search` uses zvec-grep; `architecture`/`impact` use CodeGraph; `symbol`/`references`/`implementations`/`diagnostics` use Serena. `auto` is only for a genuinely unclear query class, not a default fan-out ritual.
- `references` and `implementations` need `symbol` and `relativePath`; `diagnostics` needs `relativePath` and a focused `query` or `symbol` under lazy-intel 0.2's input validation. JavaScript cross-file references require an appropriate `jsconfig.json`/`tsconfig.json`. Empty or partial semantic results do not prove absence; use native exact search when completeness matters.
- Lazy-intel owns derived index creation, watchers, refresh and repair. Use default `freshness=auto`; request recovery controls only after a reported degraded backend. Never call standalone zvec-grep, CodeGraph or Serena MCPs, run manual index commands, or add a second autoindex extension. Preserve the shared embedding configuration.
- A sufficient current-source snippet is already-read evidence. Read more only for missing implementation detail, exact/exhaustive confirmation or changed source. If lazy-intel is unavailable, immediately continue with native tools; no user setup ritual or repeated near-identical searches.
- Stop searching when the evidence is sufficient. Neither retrieval relevance nor graph/LSP output overrides current source and actual build/test results.
- Sharpshooter is the sole durable memory owner. It injects project decisions automatically; zvec indexes source workspaces, not memory banks. Do not call unavailable memory verbs or index private OMP state.
