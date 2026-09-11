---
description: Select verification scope and independent review for implementation changes.
agents: [main]
---

# Implementation and verification

Work from current evidence and acceptance criteria. Implement the smallest coherent change, run relevant checks, and repair failures caused by that change. Ordinary recoverable failures are not handoff points. Do not alter unrelated failures or weaken valid tests to obtain green output.

Start with affected tests/build targets. Expand to shared-contract or project-wide checks when cross-cutting behavior, release readiness, regression evidence or an explicit CI requirement makes that coverage necessary. Neither a full suite for every edit nor a blanket full-suite ban is appropriate. Use existing selectors; do not redesign a test harness solely to satisfy a scope ritual.

Use one independent read-only review for material security/trust, persistence/data-integrity, concurrency, public-contract or cross-component changes. Trivial corrections and mechanical changes do not require a reviewer. Re-review affected parts after material fixes or redesign, not after every edit. When independent review is unavailable, complete safe work and report the missing review rather than impersonating it.

Repeat passing checks only after a relevant change, failure or new finding. Describe the coverage actually run and any blockers. Paid live probes, host configuration changes and production access are not disposable local tests and retain their existing authorization boundaries.
