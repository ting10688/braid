# Benchmark assets

This directory contains the small, reviewable inputs for Braid Bench. Suites in `suites/` select
tracked fixture templates and human-authored expectations. Proposal cases are copied to fresh temporary
Git repositories before `braid init`, `braid analyze`, or `braid propose` runs. Static comparisons copy
both variants independently. The templates are never benchmark workdirs and never receive dependency
installations or `.braid/state` writes.

## Included suites

- `phase-2-core`: clean modular code, an oversized notification responsibility, two- and three-module
  cycles, and a protected-path cycle. Correctness runs three times by default; one warm-up plus seven
  measured timing runs are separate. Proposal IDs, order, typed evidence, ranking components,
  persistence idempotency, exit codes, and source hashes are checked for flakiness.
- `static-comparison`: a behavior-equivalent manual notification-boundary refactor. It independently
  measures architecture, build/test behavior, timing, runtime command duration, and configured artifacts.

Run them from the repository root:

```bash
pnpm benchmark:list
pnpm benchmark:smoke
pnpm benchmark:run
pnpm benchmark:compare
pnpm benchmark:regression
node packages/benchmark/dist/cli/index.js run --suite phase-2-core --json
node packages/benchmark/dist/cli/index.js compare-runs <run-a> <run-b>
node packages/benchmark/dist/cli/index.js baseline create --run <run> --name <name> --force
node packages/benchmark/dist/cli/index.js compare-baseline <name> <candidate-run>
node packages/benchmark/dist/cli/index.js iteration --suite phase-2-core \
  --baseline-braid /path/to/baseline/braid --candidate-braid /path/to/candidate/braid
```

`protocol.yaml` versions the repetition, warm-up, timeout, and normalization contract. Suites and
expectations carry their own versions. Each selected fixture produces a deterministic SHA-256 manifest
from relative paths, file contents, architecture configuration, and expectation content. Run directories
contain immutable `manifest.json` and `fixture-manifest.json` sidecars alongside `run.json` and
`report.md`.

Generated results are ignored under `results/` except `.gitkeep`. Reviewable normalized baselines live
under `baselines/`; creating or replacing one requires `--force`. Baselines exclude absolute paths,
hostnames, usernames, temporary repositories, full logs, and universal timing assertions. The default
policy blocks correctness and stability regressions but only warns on material cost increases. Timing is
informational when environment fields differ.

To add a case, keep the fixture deterministic, supply an exact lockfile if dependencies are permitted,
write independent expectation labels with equivalent valid targets where needed, and verify build/test
behavior separately from architecture metrics. Change the suite, expectation, fixture, or policy version
when its meaning changes; never overwrite a tracked baseline without review.
