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
  proposal review, repository hashes, and source-size metadata live under `repositories/`.

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
