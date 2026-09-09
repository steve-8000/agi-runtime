---
description: Use for repository changes that require implementation, build, tests, and repair.
agents: [main]
---

Use a code-first implementation loop:

1. Inspect enough to locate the existing path and define acceptance criteria.
2. Implement the coherent requested slice before broad verification.
3. Run the narrow affected build or tests.
4. Fix observed failures and regressions.
5. Repair until the affected area passes.
6. Request one reviewer pass after the diff is coherent.

Do not substitute planning, proof seeking, or repeated review for implementation. Repeat verification only after a relevant change, a real failure, or a reviewer finding that can alter correctness.

## Test scope is the changed area only

Every verification run targets the area under change and nothing else. Create or extend a test target, suite, or harness step that belongs to that area, and run that alone.

- Never run the whole suite, every package, or an unfiltered harness as routine verification. That is prohibited, not merely discouraged, including at the end of a slice.
- If a runner or harness has no way to select one area, add the selector as part of the work: a target argument, a suite name, a step list, a size cap. Then use it.
- New tests belong to the area's own target or suite. Do not append them to a shared catch-all target that forces unrelated tests to run with them.
- A full-suite run is not part of this loop.
- Report which scope was run. Never describe a narrow run as if it covered the project.
