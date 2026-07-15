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
6. **Migration execution safety:** whether approval/freshness/scope/validation/architecture failures are
   rejected, worktrees are isolated, the main checkout remains unchanged, and complete candidate records
   and commits are produced only for safe cases.

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

For repository cases, compatibility additionally freezes the manifest version, canonical URL, full
commit SHA, license hash, lockfile hash, source-manifest hash, repository-specific Braid configuration
hash, qualification status, source size, and recorded install/build/test/analysis status. Any difference
is semantically incompatible; a changed pin therefore requires a suite/expectation review and new baseline.

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

- **Correctness:** expected-issue coverage, proposal-action validity, Top-K and evidence coverage, evidence
  correctness, risk/reversibility agreement, reviewed false positives, source mutations, build/test
  success, and expected exit-code matching. Coverage/validity/evidence-correctness decreases, false
  positives or source mutations above zero, and build/test failures block by default.
- **Stability:** case and deterministic counts, flaky cases, proposal identity/order stability, and
  persistence idempotency. New correctness flakiness blocks.
- **Cost:** median/minimum/maximum runtime, proposal count, and serialized report size. Regressions are
  normally warnings under policy tolerances. Peak memory is omitted because the current CLI runner cannot
  measure it reliably and portably.

No arithmetic mean is used as the primary timing statistic. A passing comparison may still contain cost
warnings or improvements without changing correctness.

Proposal validity uses independently reviewed technical actions: accepted primary/alternative matches
plus informational actions divided by that count plus rejected or unexpected actions. An SCC primary
can therefore retain several accepted actions without counting its alternatives as independently ranked
top-level proposals. Matching consumes actions deterministically, so the ratio cannot exceed 100%.
Ambiguous reviews remain outside the denominator.

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

### Phase 3 execution suite

Implemented as `phase-3-execution@1.0.0` with benchmark protocol `1.0.0`. It uses only the injected
scripted executor and the production orchestrator; live Codex is never a required CI input. Ten explicit
cases cover valid notification extraction, stale proposal, wrong approval, unauthorized file,
dependency mutation, required validation failure, new cycle, no-op, executor timeout, and safe discard.

The report keeps separate case/status rows and metrics for preflight correctness, scope compliance,
main-checkout mutations, successful/rejected migrations, validation, candidate commits,
predicted-versus-actual comparison, worktree isolation, deterministic plans, complete records, and
runtime. It never combines them into a quality score. Any main mutation, accepted scope/dependency/
approval/staleness/validation/cycle violation, missing record, or nondeterministic plan is blocking.

```bash
pnpm benchmark:migration:smoke
pnpm benchmark:migration:run
pnpm benchmark:migration:regression
```

## Independence and fixture isolation

The proposal evaluator depends on public `@braid/core` schemas but not on `@braid/planner` or
`@braid/analyzer`. Braid is invoked as `node apps/cli/dist/index.js` by default, and the evaluator owns
its source/import/module/cycle measurement. The Phase 3 suite separately depends on the public migrator
and test-fixture interfaces because its subject is the orchestrator itself; it asserts Git and portable
record outcomes rather than asking the orchestrator to grade its own architecture facts.

Every fixture run uses a fresh temporary copy, initializes a local Git repository with a fixed author and
timestamp, creates one baseline commit, and records source hashes before and after. `.braid/state` is
excluded from source mutation results; source, tests, manifests, lockfiles, TypeScript configuration, and
the architecture configuration are not. Temporary directories are deleted unless `--keep-workdirs` is
specified. Synthetic suites require no network.

Every real-world run first verifies the ignored canonical cache checkout: exact detached HEAD, canonical
fetch URL, disabled push URL, MIT license hash, exact lockfile hash, source manifest, source counts, LOC,
and module count. It then makes a local no-hardlink clone in a fresh temporary directory, removes `origin`,
and runs Braid only there. Cached runs never fetch and never execute dependency installation; explicit
qualification may restore dependencies, while explicit refresh is the only repository network operation.

## Expectations, reproducibility, and reports

Expectation files are versioned. They label issue type, equivalent acceptable targets, required evidence,
allowed human risk/reversibility labels, and Top-K requirements without requiring exact titles or prose.
Human labels can be incomplete, so disagreements remain visible rather than silently treating the label
as infallible.

Real-world expectations also classify reviewed non-required output as `rejected`, `ambiguous`, or
`informational`. Rejected output counts as a false positive, ambiguous output is reported but excluded
from the proposal-validity denominator, and informational output is allowed. Matchers use technical shape
(such as a cycle edge and bounded affected scope), never current proposal IDs or exact summary wording.

JSON is the source-of-truth report; console and Markdown are projections. Persisted reports normalize
workspace and fixture paths, and environment fingerprints omit username, home directory, hostname,
secrets, and unrelated machine data. Comparison reports separate blocking regressions, warnings,
improvements, and unchanged results across correctness, stability, and cost.

Tracked timing summaries are informational on uncontrolled machines; seven tiny repetitions do not
establish statistical significance.

## Real-world Phase 2 suite

`real-world-phase-2` contains two independently reviewed MIT TypeScript repositories:

- **Consola** at `c47faac1738b7383971c6c20b5a34ffa15e7cc3b` is the low-complexity
  false-positive control. It is `qualified`, although its 21 source files are below the preferred range.
- **tslog** at `07d3e31ea36ae1074accb0097bdc53bd73c93e13` is the complexity case with
  multiple runtime entrypoints, subpaths, transports, presets, serializers, and CLI code. It is
  `qualified-with-limitations`: browser/Bun/Deno tests are excluded and six native-preview files produce
  parser diagnostics while still yielding imports and declarations.

Qualification uses pinned lockfiles and disabled lifecycle scripts. Consola runs `pnpm build` and
`pnpm vitest run`; tslog runs `npm test` and `npm run build`. The latter's upstream build includes a local
`prepare-publish` file-preparation step, but no release, pre-publish, credentialed, or publishing command
is run. The suite itself runs only Braid analysis/proposal work from cache and remains network-free.

```bash
pnpm benchmark:real:list
node packages/benchmark/dist/cli/index.js repositories inspect consola
pnpm benchmark:real:qualify
pnpm benchmark:real:run
pnpm benchmark:real:regression

# Explicit network refresh; never implicit in CI
node packages/benchmark/dist/cli/index.js repositories refresh consola
```

The tracked `real-world-phase-2-v1` baseline remains the Phase 2 historical record. Before the reviewed
metadata version changed, the Phase 2.1 candidate was compared with those exact 1.0.0 inputs: output fell
from 11 to 2 top-level proposals, validity rose from 37.5% to 75%, and false positives fell from 5 to 1;
coverage, evidence correctness, deterministic cases, flakiness, and source mutations were unchanged.
The separately named `real-world-phase-2-precision-v1` baseline freezes the reviewed 1.1.0 suite and
expectation metadata. Timing is retained for local reports but is warning-only across differing
environments and is never a cross-machine gate. Normal CI runs synthetic regression plus schema/manifest
validation; it does not clone or refresh external input.

The remaining reviewed false positive is a name-linked stringify helper cluster inside tslog's JSON
renderer. Its references are factual, but static identifiers do not prove that moving the existing
public helper and its private hot-path functions would create a better module boundary. SCC alternatives
are likewise technically plausible graph actions, not semantic architecture judgments.

To replace a rejected candidate, record the rejection, select a replacement in a separate reviewed change,
repeat license/lockfile/source/build/test/Braid qualification, then bump suite and expectation versions.
A moving branch, silent replacement, or reused baseline is never compatible.
