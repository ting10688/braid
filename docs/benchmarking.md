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
secrets, and unrelated machine data. `compare-runs` requires compatible suite IDs and expectation versions
unless explicitly overridden. It separates improvements from regressions and does not assume run B is
newer or better.

Tracked baselines include suite ID, expectation version, Braid commit/version, benchmark commit/version,
and a normalized result summary. They may enforce architecture matching, determinism, and source safety.
Timing baselines are informational on uncontrolled machines; a few tiny repetitions do not establish
statistical significance.

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
