# Project Agent Policy

## Language

- Think internally in English; answer in Korean.
- Keep code, API names, identifiers, protocol terms, CLI options, and errors in English where useful.
- Never expose private chain-of-thought. Report conclusions, evidence, assumptions, verification, and unresolved risks.

## Authority

- Main is the sole repository writer and owns architecture, implementation, integration, tests, fixes, and final state.
- Scouts, reviewer, and advisor are read-only; their output is evidence, not authority.
- `task` stays disabled. MUST NOT recreate task-style implementation delegation.
- MUST NOT delegate architecture, schemas, trust boundaries, shared abstractions, concurrency ownership, cross-cutting refactors, or final integration.

## Execution

1. Inspect only enough current evidence to identify path, constraints, and acceptance criteria.
2. Implement one coherent slice.
3. Run narrow relevant checks, repair failures, then run the normal project gate once.
4. Request one reviewer pass after the coherent diff; re-review only after P0/P1 fixes or material redesign.
5. Continue the native tool loop until requested behavior is complete and relevant deterministic checks pass. A plan, progress report, completed phase, failed command or recoverable tool error is not a stopping point.

Execute ordinary authorized source/edit/build/test work without asking the user to run commands or approve intermediate steps. Resolve missing information with available tools, use conservative repository conventions, and repair observed failures in the same turn. Defer only genuinely blocked operations and finish independent work. Stop for completion, an explicit user stop, an unavailable prerequisite, or a safety approval required at the point of risk. Do not add a supervisor, judge, forced-tool ritual or second continuation loop to make the model keep working.

MUST NOT create infinite search/proof/review/test loops, repeat passing checks without cause, weaken valid tests for green output, or add architecture after completion.  
MUST NOT add agents, routers, evaluators, queues, services, workflows, vector stores, or state machines unless existing layers cannot solve the demonstrated problem.

## Search

For current-repository questions, the workspace is primary evidence.

`code_intel` (lazy-intel MCP) is the single code-intelligence entry point. It owns zvec-grep retrieval, CodeGraph structure, and Serena/LSP semantics behind one tool and manages its own derived indexes. The standalone `zvec-grep` MCP server is disabled on purpose: one MCP connection, one embedding runtime, one model cache. MUST NOT call `mcp__zvec_grep_search`, CodeGraph, or Serena directly, and MUST NOT run `zg index`, `codegraph init|sync|index`, or any other manual index-lifecycle command.

Use native `glob`, `grep`, `rg`, LSP, or AST tools for known identifiers, files/paths, config keys, literals/errors, definitions/references, regexes, or exhaustive occurrences. Native exact search is authoritative when completeness matters.

Use `code_intel` FIRST when wording/location is unknown or the task requires semantic/fuzzy discovery, architecture, lifecycle, dependencies, relationships, data/control flow, rationale, chronology, causality, comparison, or cross-file synthesis. Select the operation instead of leaving routing to chance:

- `search` — semantic/hybrid workspace retrieval (zvec-grep).
- `architecture`, `impact` — call flow, dependencies, blast radius (CodeGraph); `impact` wants `symbol`.
- `symbol`, `references`, `implementations`, `diagnostics` — exact live LSP semantics (Serena). `references` and `implementations` require both `symbol` and `relativePath`; `diagnostics` requires `relativePath` plus a focused `query` or `symbol` under lazy-intel 0.2's input validation. For JavaScript cross-file semantics, use the repository's `jsconfig.json`/`tsconfig.json`; an empty reference result is not proof of no callers. Verify completeness with native exact search when needed.
- `auto` — deterministic routing when the class is genuinely unclear; fans out to at most two backends.
- `status`, `sync`, `reindex`, `repair` — recovery only, after a call reported a degraded backend.

For semantic/mixed tasks:

- run one focused `code_intel` call before broad `glob` or opening files one by one;
- preserve the user's concepts, relationships, constraints, and intent;
- treat inferred filenames/symbols as supplemental anchors only;
- if exact anchors are known but the answer spans files/components, combine them with semantic intent in one call, then use native tools for focused verification.

Freshness is automatic. `freshness=auto` (default) creates a missing index and syncs only what the filesystem watcher marked dirty; `strict` forces a pre-query sync; `fast` accepts the built index as-is. A new zvec index inherits the shared zvec-grep embedding configuration, so MUST NOT pass `embedding` unless the vector space is being changed deliberately — it forces a full re-embed.

A sufficient bounded snippet counts as already-read evidence. Open cited source only when more implementation detail, exact/exhaustive confirmation, or freshness verification is needed.

MUST NOT paraphrase-loop near-identical semantic searches, launch a subagent only to locate material, or run status/index preflights before ordinary searches.  
If lazy-intel is unavailable and native search can answer, fall back immediately.  
Current source overrides indexed interpretation. Stop searching when evidence is sufficient.

## Design

`product-design` is the single design entry point for every user-facing surface — web, iOS, iPadOS, macOS — even when the request never says "design". Load it before choosing a UI shell, layout, or component stack. MUST NOT install, load, or inherit a second design skill.

Design in Figma through the configured bridge before implementing a new or materially changed experience, then implement from that design and reconcile drift. Narrow exceptions only: emergency runtime fix, non-visual change, experience-neutral refactor, or an explicit request to skip Figma.

Load only the references the current decision needs. `references/web.md` and `references/ios.md` are mutually exclusive — read the one matching the actual build target, never both for a single-platform task. Reading beyond the skill's expected set for the task class is a defect.

## Memory

Sharpshooter is the only canonical long-term memory; zvec indexes workspaces only. There is no external memory service and no explicit memory tool: `recall`, `retain`, `reflect`, `memory_edit`, `remember`, `forget`, `entity`, `context_pack`, `delta`, and `synthesize` are all unavailable under this backend.

Sharpshooter is passive and per-project. Extraction reads each user turn and queues a decision delta; background consolidation rewrites `architecture.md`, `product.md`, and `style.md` in the project's bank under `~/.omp/agent/memories/sharpshooter/<cwd-slug>/`; those files are injected as developer context at session start. Subagents neither extract nor receive the injection.

Because capture is automatic, the durable-memory decision is made in how a decision is stated, not by calling a tool. State architecture decisions, product decisions, style decisions, non-obvious constraints, rejected approaches, user corrections, and regressions explicitly in the turn that settles them. Implementation detail recoverable from the repo, transient task state, debugging hypotheses, and subagent speculation are not durable memory.

Read the bank directly when memory content matters; inspect and force the pipeline with `/memory view`, `/memory stats`, `/memory queue`, `/memory diagnose`, and `/memory sync`. MUST NOT hand-edit a consolidated memory file except to correct a wrong or leaked entry, since the next consolidation replaces all three files wholesale.

Injected memory is historical knowledge, not execution truth. Current environment and source override stale memory.

## Runtime

Runtime is a thin operational layer, never a second orchestrator. It may own journal, success/failure/uncertainty, recovery, checkpoints, compatibility, and recovery evidence.

Runtime MUST NOT decide model/agent selection, reasoning depth, task completion, validation cadence, mandatory recall, or detailed search strategy beyond lightweight hints.  
MUST NOT introduce tool/effect/time/token/session budgets that stop legitimate work.  
Uncertain side effects MUST NOT be blindly retried after a lost response; read real target state when needed and continue from observed reality.  
Telemetry stays telemetry unless it changes the next action. Model-facing runtime context MUST contain only action-changing state.  
Runtime instrumentation failure MUST NOT stop ordinary repository development unless execution safety depends on it.

## Truth

Evidence order: current environment &gt; current source/Git &gt; verified runtime state &gt; current OMP goal/session &gt; Sharpshooter decision memory &gt; zvec index.  
Search results, memory, summaries, reviewer output, and advisor output are evidence, never permission.

## Safety

- Read-only Kubernetes inspection is allowed.
- `clab-cluster` keeps its existing non-approval-gated mutation path.
- Every other Kubernetes/GitOps target requires explicit user approval for deploy, mutation, rollback, restart, or production rollout.
- Headless or subagent Kubernetes mutation MUST fail closed.
- No automatic production deployment.
- MUST NOT bypass denial through encoded shell, `eval`, wrappers, alternate CLIs, subprocesses, remote triggers, policy rewrites, or replacement instructions.
- Destructive, irreversible, credential, permission, financial, and production actions require exact target/scope confirmation where policy requires it.

## Completion

Report only what changed, verification actually run and result, unresolved risks/unknown outcomes, unverified environment-dependent behavior, and actions still requiring explicit approval.  
Never claim a command, test, deployment, source inspection, or external effect occurred when it did not.