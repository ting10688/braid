# Braid Bench methodology

## What it measures

Braid Bench answers separate questions instead of collapsing them into one score:

1. **Architecture quality:** whether Braid detects labeled structural problems, supplies correct evidence,
   ranks required issues near the top, and reports appropriate risk and reversibility.
2. **Change cost:** whether a refactored repository requires fewer modules, files, failed validations, or
   agent iterations for the same successful feature task. Phase C defines this data but does not run agents.
3. **Behavioral safety:** whether required build and test commands still pass and observable behavior is
   preserved.
4. **Performance and size guardrails:** build, test, runtime-command duration, and explicitly configured
   artifact size. These are neutral constraints, not evidence of better architecture.
5. **Reversibility:** whether a migration can later be rolled back safely and restore the source tree.
   Phase D defines this data but does not execute migration or rollback.

Source size may increase after a useful boundary is introduced. Runtime on a tiny fixture may move in
either direction due to noise. Neither outcome automatically decides architecture quality, and no opaque
aggregate benchmark score is produced.

## Fair iteration protocol

`benchmarks/protocol.yaml` is the versioned execution contract. A comparison is intended to change only
the Braid implementation. It freezes the protocol version, suite ID and version, expectation version,
selected case configuration, fixture manifest, correctness repetition count, timing repetition count,
warm-up count, and timeout. Suite `execution` fields may override protocol defaults, but both runs must
resolve to the same values.

Every run writes two immutable sidecars:

- `manifest.json` records Braid and benchmark versions/commits, semantic input hashes, environment fields,
  execution counts, timeout, and a path-redacted command.
- `fixture-manifest.json` records fixture IDs, relative file paths and SHA-256 content hashes,
  architecture-configuration hashes, expectation-file hashes, and its normalized SHA-256 hash.

Compatibility hashes contain no timestamps or absolute paths. `compare-runs` marks a comparison
incompatible if protocol version, suite ID/version, expectation version, fixture manifest hash,
configuration hash, correctness repetitions, or timeout policy differs. Timing/warm-up counts are also
held fixed. `--allow-incompatible` reveals informational metric rows but never hides the incompatibility
or changes the overall result from `incompatible`.

Material environment differences in platform, architecture, Node, pnpm, or Git do not prevent
correctness comparison when semantic inputs match. They do force runtime rows to warning/informational
status; Braid Bench never presents cross-machine timing as controlled evidence.

## Repetitions, normalization, and flakiness

Correctness defaults to three repetitions. Timing defaults to seven measured repetitions after one
excluded warm-up; reports use median as the primary runtime measure and retain minimum/maximum. Suite
overrides are explicit and recorded in the run manifest.

Correctness normalization removes only protocol-listed volatility: run IDs, timestamps, temporary
directory paths, timing samples, and generated `.braid/state` paths. Proposal IDs and order, targets,
affected files, evidence, risk, reversibility, ranking components, exit codes, and source mutations remain
meaningful. A case is flaky if any normalized correctness output differs. Reports identify each differing
field and the one-based repetitions involved. The default policy treats any flaky case as blocking.

## Regression policy and metric categories

`benchmarks/policies/default.yaml` is validated and versioned. Every metric status includes the rule and
observed outcome that produced it; thresholds are not embedded in report rendering.

- **Correctness:** expected-issue coverage, proposal validity, Top-K and evidence coverage, evidence
  correctness, risk/reversibility agreement, clean-fixture false positives, source mutations, build/test
  success, and expected exit-code matching. Coverage/validity/evidence-correctness decreases, false
  positives or source mutations above zero, and build/test failures block by default.
- **Stability:** case and deterministic counts, flaky cases, proposal identity/order stability, and
  persistence idempotency. New correctness flakiness blocks.
- **Cost:** median/minimum/maximum runtime, proposal count, and serialized report size. Regressions are
  normally warnings under policy tolerances. Peak memory is omitted because the current CLI runner cannot
  measure it reliably and portably.

No arithmetic mean is used as the primary timing statistic. A passing comparison may still contain cost
warnings or improvements without changing correctness.

## Golden baselines and iteration workflow

Golden baselines under `benchmarks/baselines/` contain the complete compatibility manifest, normalized
correctness/stability summaries, informational cost summary, and source Braid/benchmark versions and
commits. They contain no raw logs, hostnames, usernames, absolute paths, temporary paths, or universal
timing assertions. Creation and replacement require explicit `--force` confirmation:

```bash
pnpm benchmark:baseline create --run benchmarks/results/<run> --name phase-2-core --force
pnpm benchmark:baseline list
pnpm benchmark:baseline show phase-2-core
node packages/benchmark/dist/cli/index.js compare-baseline phase-2-core <candidate-run>

pnpm benchmark:iteration --suite phase-2-core \
  --baseline-braid /path/to/baseline/braid \
  --candidate-braid /path/to/candidate/braid \
  --output benchmarks/results/my-iteration
```

`iteration` creates `baseline/` and `candidate/` normal run directories, then writes
`comparison.json`, `comparison.md`, and `comparison.txt`. Exit code `0` means pass or warnings only,
`2` means a blocking regression, `3` means incompatible inputs, and `1` means an execution or validation
error. `benchmark:regression` repeats the smoke suite and compares correctness/stability with the tracked
smoke baseline; cross-environment timing remains informational and cannot fail CI.

## Phases

### A — proposal quality and determinism

Implemented. Braid runs through its CLI. Public `@braid/core` Zod schemas validate the JSON, while
independently authored expectations match equivalent files, modules, symbol clusters, or cycle edges.
Metrics include expected-issue coverage, proposal validity, false positives, Top-K coverage, evidence
coverage and correctness, risk/reversibility agreement, deterministic identity/order/evidence/ranking,
persistence idempotency, runtime, and source mutation count.

Evidence is checked against an evaluator-owned scan of fixture files. It verifies file and module
existence, LOC thresholds, module sizes, cycle membership, selected edges, import counts, public
entrypoints, protected paths, and configuration constraints. It does not ask planner candidate selection
or ranking code whether the planner was right.

### B — static before/after comparison

Implemented. Both variants are independently copied and measured. The report separates source files,
LOC, modules, imports, cycles, oversized files/modules, and entrypoints from build/test outcomes and from
timing/artifact guardrails. Change magnitude is computed from normalized source trees rather than
unrelated Git history. Duration samples report median, minimum, maximum, and repetition count.

### C — downstream feature change cost

Schema and documentation only. A future runner will apply the same prompt and validation contract to
baseline and refactored repositories. It will record task success, files and modules touched, source diff
lines, changed tests, command attempts, failed validations, agent iterations, tool calls, elapsed time,
input/output tokens when available, architecture violations, and budget compliance.

The primary future metric is **modules touched per successful feature task**. Files touched, validation
failures, iterations, elapsed time, and token usage are secondary. Fewer changed lines are not always
better. No Codex orchestration exists in this benchmark phase yet.

### D — rollback validation

Schema and documentation only. A future runner will perform an approved migration, validate it, execute
rollback, rerun build/tests, detect dependent migrations, measure rollback duration, and compare source
hashes. Restoration hashing excludes `.braid/state/**`, `node_modules/**`, `dist/**`, `build/**`, and
`coverage/**`; a case may explicitly allow generated-state differences. No migration or rollback is
executed by Braid Bench today.

## Independence and fixture isolation

`@braid/benchmark` depends on public `@braid/core` schemas but not on `@braid/planner` or
`@braid/analyzer`. Braid is invoked as `node apps/cli/dist/index.js` by default. The evaluator owns its
source/import/module/cycle measurement and compares CLI proposals with human labels. Braid metric changes
alone never declare a benchmark successful.

Every fixture run uses a fresh temporary copy, initializes a local Git repository with a fixed author and
timestamp, creates one baseline commit, and records source hashes before and after. `.braid/state` is
excluded from source mutation results; source, tests, manifests, lockfiles, TypeScript configuration, and
the architecture configuration are not. Temporary directories are deleted unless `--keep-workdirs` is
specified. Synthetic suites require no network.

## Expectations, reproducibility, and reports

Expectation files are versioned. They label issue type, equivalent acceptable targets, required evidence,
allowed human risk/reversibility labels, and Top-K requirements without requiring exact titles or prose.
Human labels can be incomplete, so disagreements remain visible rather than silently treating the label
as infallible.

JSON is the source-of-truth report; console and Markdown are projections. Persisted reports normalize
workspace and fixture paths, and environment fingerprints omit username, home directory, hostname,
secrets, and unrelated machine data. Comparison reports separate blocking regressions, warnings,
improvements, and unchanged results across correctness, stability, and cost.

Tracked timing summaries are informational on uncontrolled machines; seven tiny repetitions do not
establish statistical significance.

## Future real-world repositories

Real-world cases will record repository URL, exact commit SHA, license metadata, setup/build/test commands,
and local cache metadata. Network cloning is intentionally absent from the current runner. The workflow is:

```text
pin repository commit
review license
prepare local cached checkout
define architecture expectations
define one or more downstream feature tasks
run baseline
apply Braid migration
rerun comparison
```

A moving default branch is never a valid benchmark input.
