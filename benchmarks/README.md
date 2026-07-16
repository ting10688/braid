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
- `real-world-phase-2`: pinned Consola control and tslog complexity cases. Both use three correctness
  repetitions, one warm-up, and seven timing repetitions. Qualification, accepted/rejected/ambiguous
  proposal review, repository hashes, and source-size metadata live under `repositories/`. The 1.1.0
  precision review groups SCC actions and distinguishes root files, entrypoints, and barrels.
- `phase-3-execution`: ten direct orchestrator cases using the CI-only scripted executor. It separately
  reports safe success, each unsafe rejection, worktree isolation, main-checkout integrity, validation,
  candidate commits, predicted/actual comparison, deterministic plans, complete records, and runtime.
  Its frozen 1.0.0 blocking contract is under `migration/phase-3-execution-v1.json`.
- `phase-3-1-execution-readiness`: ten independent symbol-closure cases covering companion precision,
  retained dependencies, unresolved/reverse/cycle/budget/protected blockers, deterministic output, a
  zero-launch rejection, and one complete orchestrated extraction.
- `phase-3-2-proposal-repair-suggestions@1.0.0`: fourteen independent cases covering actionable,
  partial, and unavailable suggestions; minimal additive companion sets; retained/imported symbols;
  unresolved, protected/public, cycle, budget, and legacy blockers; in-memory readiness verification;
  zero-launch rejection of the original proposal; and a separately revised proposal reaching readiness.
  It reports state accuracy, actionable precision/recall, minimality, false-actionable/false-unavailable,
  deterministic IDs/order, prevented launches, revised readiness, main-checkout integrity, and scope
  safety without changing earlier baselines.

Run them from the repository root:

```bash
pnpm benchmark:list
pnpm benchmark:smoke
pnpm benchmark:run
pnpm benchmark:compare
pnpm benchmark:regression
pnpm benchmark:real:list
pnpm benchmark:real:qualify
pnpm benchmark:real:run
pnpm benchmark:real:regression
pnpm benchmark:migration:smoke
pnpm benchmark:migration:run
pnpm benchmark:migration:regression
pnpm benchmark:readiness
pnpm benchmark:repair-suggestions
node packages/benchmark/dist/cli/index.js repositories inspect consola
node packages/benchmark/dist/cli/index.js repositories refresh consola
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

`real-world-phase-2-v1` is preserved as the historical 1.0.0 baseline;
`real-world-phase-2-precision-v1` is the 1.1.0 precision baseline. The controlled 1.0.0-input comparison
records 11 → 2 top-level proposals, 37.5% → 75% proposal-action validity, and 5 → 1 false positives with
coverage, evidence correctness, determinism, and source safety unchanged. A direct cross-version
baseline comparison remains intentionally incompatible because suite and expectation hashes are frozen.

Real repositories are cloned only by the explicit `repositories refresh <id>` command. The verified
canonical checkout lives under the ignored `.braid-bench-cache/repositories/` directory with detached
HEAD and a disabled push URL. Cached suite runs require no network: each run locally clones the cache to
a new temporary directory, removes its remote, runs Braid, checks source hashes, and deletes the copy.
Normal CI validates schemas, manifests, configs, and synthetic regression; it never refreshes repositories.

Changing a repository commit requires a new suite version, expectation version, source/lockfile/license
hash review, fresh qualification, proposal review, and a newly named baseline. If a candidate is rejected,
remove it from the suite, document the rejection, and submit an independently reviewed replacement in a
separate change—never silently substitute another repository.

To add a case, keep the fixture deterministic, supply an exact lockfile if dependencies are permitted,
write independent expectation labels with equivalent valid targets where needed, and verify build/test
behavior separately from architecture metrics. Change the suite, expectation, fixture, or policy version
when its meaning changes; never overwrite a tracked baseline without review.
