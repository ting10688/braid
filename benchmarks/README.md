# Benchmark assets

This directory contains the small, reviewable inputs for Braid Bench. Suites in `suites/` select
tracked fixture templates and human-authored expectations. Proposal cases are copied to fresh temporary
Git repositories before `braid init`, `braid analyze`, or `braid propose` runs. Static comparisons copy
both variants independently. The templates are never benchmark workdirs and never receive dependency
installations or `.braid/state` writes.

## Included suites

- `phase-2-core`: clean modular code, an oversized notification responsibility, two- and three-module
  cycles, and a protected-path cycle. Each case runs twice to check proposal IDs, order, typed evidence,
  ranking components, persistence idempotency, and source hashes.
- `static-comparison`: a behavior-equivalent manual notification-boundary refactor. It independently
  measures architecture, build/test behavior, timing, runtime command duration, and configured artifacts.

Run them from the repository root:

```bash
pnpm benchmark:list
pnpm benchmark:smoke
pnpm benchmark:run
pnpm benchmark:compare
node packages/benchmark/dist/cli/index.js run --suite phase-2-core --json
node packages/benchmark/dist/cli/index.js compare-runs <run-a> <run-b>
```

Generated results are ignored under `results/` except `.gitkeep`. Expectations and any future baselines
must not contain absolute paths, machine-specific timing claims, temporary repositories, logs, secrets,
or generated dependencies. Timing is informational unless a suite supplies an explicit tolerance.

To add a case, keep the fixture deterministic, supply an exact lockfile if dependencies are permitted,
write independent expectation labels with equivalent valid targets where needed, and verify build/test
behavior separately from architecture metrics.
