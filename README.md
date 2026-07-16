# Braid

**Continuous architecture evolution for growing codebases.**

> Braid continuously restructures growing codebases, weaving new features into healthier architecture while keeping every change verifiable and reversible.

Braid is a continuous architecture evolution tool for growing codebases. It analyzes architectural
drift, helps place new features into appropriate boundaries, and supports incremental, verifiable, and
reversible architecture changes. Version 0.4.0 adds a bounded Growth Mode that reports supported
architecture regressions inside an ordinary Codex session, while preserving the explicit approval and
isolated-execution boundaries for local TypeScript projects.

## Current scope

Braid scans configured TypeScript and TSX files without executing them, resolves relative and
tsconfig-aliased imports, classifies modules, finds file/module dependency cycles, calculates raw
architecture metrics, and saves validated JSON snapshots under `.braid/state/snapshots/`.
It explicitly distinguishes feature, infrastructure, entrypoint, barrel, and top-level root-file
modules. It can then generate evidence-backed `break-cycle` and `extract-module` proposals and
atomically save them under `.braid/state/proposals/`. Cycle proposals use one ranked primary plus typed
alternatives for each deterministic strongly connected root cause.
Proposal precision is measured with reproducible synthetic and pinned real-world benchmark suites.
An approved low-risk, easy-reversibility `extract-module` proposal can now run through a deterministic
readiness gate and plan, an owned external Git worktree, a disposable no-remote executor staging repository, a bounded
Codex `workspace-write` process, independent Git diff inspection, configured validation, architecture
comparison, and one local candidate commit. When readiness is `not-ready`, Braid can instead derive an
advisory suggestion for the smallest bounded addition to `approvedCompanionSymbols`; it never applies,
stores, approves, or executes the suggested revision.

The long-term vision has two modes:

- Growth Mode now guards supported architecture changes relative to a live session baseline; later
  versions can add feature-intent and prerequisite analysis.
- Recovery Mode will propose, execute, validate, and roll back small evidence-based migrations for
  existing architectural drift.

Automatic merge, push, pull-request creation, rollback execution, automatic repair, and `break-cycle`
execution are not implemented. Braid never autonomously applies a proposal to the main checkout.

## Requirements and installation

- Node.js 22 or a compatible current LTS release
- pnpm 11

```bash
git clone <repository-url> braid
cd braid
pnpm install
pnpm build
pnpm --filter @braid/cli link --global
```

The global link is optional; during development, run `node apps/cli/dist/index.js` in place of
`braid`.

## CLI

Initialize project-local state:

```bash
braid init
braid init path/to/project
braid init --force
```

Analyze a configured project:

```bash
braid analyze
braid analyze --json
braid analyze --no-save
```

Generate migration proposals from a fresh analysis or an existing snapshot:

```bash
braid propose
braid propose --json
braid propose --no-save
braid propose --limit 1
braid propose --type extract-module
braid propose --type break-cycle
braid propose --snapshot S-abc123def456-20260715T120000000Z
```

`braid propose` is proposal-only. Saving may write snapshots and proposal JSON under `.braid/state`,
but source, tests, manifests, and TypeScript configuration are never modified. `--no-save` performs no
writes. JSON mode emits one JSON document to stdout; diagnostics remain on stderr.

Example proposal summary:

```text
Braid migration proposals

Proposals: 2
Recommended first candidate: P-BC-4d35cc34

1. [break-cycle] Break orders → users cycle edge
   Risk: low
   Reversibility: conditional
   Expected impact (simulated): circularDependencies decrease (-1)
   Alternatives: 1

2. [extract-module] Extract notification responsibilities from order-service.ts
   Risk: low
   Reversibility: easy
   Expected impact (estimated): oversizedFiles unknown
```

Example console output:

```text
Braid analysis

Project: /path/to/braid/examples/bloated-saas
Source files: 6
Modules: 4
Internal imports: 7
External imports: 1
Cross-module imports: 5
Circular dependencies: 1 [warning]
Oversized files: 2 [warning]
Oversized modules: 3 [warning]
Public entrypoints: 3

Snapshot: S-abc123def456-20260715T120000000Z
Saved: .braid/state/snapshots/S-abc123def456-20260715T120000000Z.json
```

`--json` writes only valid snapshot JSON to stdout. Diagnostics go to stderr. `--no-save` performs the
same analysis without creating a snapshot file.

Plan, execute, inspect, or explicitly discard a safe extraction candidate:

```bash
braid migrate plan P-EM-a18d42f3
braid migrate suggest P-EM-a18d42f3
braid migrate run P-EM-a18d42f3 --approve P-EM-a18d42f3
braid migrate list
braid migrate status E-00000000-0000-4000-8000-000000000001
braid migrate inspect E-00000000-0000-4000-8000-000000000001
braid migrate diff E-00000000-0000-4000-8000-000000000001
braid migrate discard E-00000000-0000-4000-8000-000000000001 \
  --confirm E-00000000-0000-4000-8000-000000000001
```

Migration is disabled by default. The project configuration must explicitly enable it and provide
trusted executable-plus-argument validation commands. `run` accepts only the production `codex`
executor, requires the exact proposal ID in `--approve`, and supports `--model`,
`--reasoning-effort`, `--timeout`, `--json`, and `--no-commit`. It never merges or pushes. See the
[migration safety and lifecycle guide](docs/migrations.md).

`migrate plan` reports `ready`, `ready-with-warnings`, or `not-ready`, including required companions,
retained/external/unresolved dependencies, predicted import direction, cycle risks, and stable reasons.
`migrate run` never adds a companion on the user's behalf; `not-ready` exits before any worktree,
staging repository, executor process, or candidate branch is created. `migrate suggest` is a separate,
advisory analysis that reports exactly one of `actionable`, `partial`, or `unavailable` and proposes only
additions to `approvedCompanionSymbols`. It creates no execution resources or records and does not mutate
or persist the proposal.

```text
$ braid migrate suggest P-EM-...

Suggestion: actionable
Current readiness: not-ready
Predicted readiness: ready

Add approved companion symbols:
- SentNotification

Reason:
- required local type used by NotificationService
- leaving it behind would create a reverse dependency

No proposal was modified.
Create or approve a revised proposal before execution.
```

Even an actionable suggestion leaves the original proposal non-executable. To proceed, store a separate
revised proposal containing the approved companion symbols, then explicitly approve that revised
proposal's own ID through the normal migration flow.

Install the repository-local Codex Growth Mode adapter after enabling `growthMode` in the project
configuration:

```bash
braid growth install codex --dry-run
braid growth install codex --confirm
braid growth context
braid growth check --session my-session
braid growth final --session my-session
braid growth status --session my-session
braid growth reset --session my-session --confirm my-session
braid growth uninstall codex
```

Codex requires the exact hook definitions to be reviewed with `/hooks`. Growth Mode compares the
current working tree with the session baseline and never edits source or invokes migration execution.
See the [Growth Mode guide](docs/growth-mode.md) for lifecycle, finite Stop behavior, caching,
installation ownership, and limitations.

## Development

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:watch
pnpm format
pnpm braid --help
pnpm analyze:example
pnpm propose:example
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
pnpm benchmark:growth-mode
```

Braid Bench freezes protocol, suite, expectation, fixture, configuration, repetition, and timeout
inputs before comparing two Braid executables. A run records immutable manifests, separates
correctness/stability/cost metrics, and treats timing across different environments as informational.
Create a reviewable baseline with `pnpm benchmark:baseline create --run <run> --name <name>
--force`, or run a direct comparison with `pnpm benchmark:iteration --suite phase-2-core
--baseline-braid <path> --candidate-braid <path>`. See the benchmark methodology for report formats,
compatibility rules, and exit codes.

The real-world Phase 2 suite evaluates pinned Consola and tslog checkouts from the ignored
`.braid-bench-cache/repositories/` cache. Consola is the false-positive control; tslog exercises dense
runtime, transport, preset, serializer, subpath, and CLI boundaries. Normal runs are network-free and
clone each verified cache checkout into a fresh remote-free temporary directory. Network refresh is
always explicit, for example `node packages/benchmark/dist/cli/index.js repositories refresh consola`.
Neither third-party repository is vendored or used as a Braid source dependency. Phase 2.1 reduced the
reviewed real-world output from 11 to 2 top-level proposals, raised action validity from 37.5% to 75%,
and reduced false positives from 5 to 1 while retaining 100% expected-issue and evidence correctness.

The example app is intentionally healthy at runtime but architecturally awkward. It contains a
users/orders cycle, mixed notification logic, cross-module imports, a large shared module, and a local
threshold that marks the order service as oversized. Its 24 behavior tests all pass.

## Repository guide

- `apps/cli`: Commander-based `braid` command and console/JSON presentation.
- `packages/core`: Zod domain schemas and validated YAML configuration.
- `packages/analyzer`: TypeScript scanning, import graph, cycle detection, module classification, metrics.
- `packages/planner`: pure deterministic candidate generation, classification, identity, and ranking.
- `packages/migrator`: deterministic plans, worktree ownership, bounded executors, scope enforcement,
  readiness and advisory repair evaluation, validation, architecture comparison, and candidate commits.
- `packages/guard`: session baselines, Git/source fingerprints, architecture comparison, bounded
  feedback, ephemeral state, and the Codex hook adapter.
- `packages/store`: atomic JSON project, snapshot, proposal, and execution-record persistence.
- `packages/benchmark`: independent fixture isolation, repeated evaluation, regression policies, baselines,
  iteration comparison, and reports.
- `packages/shared`: errors and project-local path constants.
- `benchmarks`: versioned synthetic and pinned real-world suites, reviewed expectations, fixture templates,
  repository metadata, and ignored run results.
- `examples/bloated-saas`: deterministic integration fixture and runnable TypeScript application.

See [architecture](docs/architecture.md), [proposal behavior](docs/proposals.md),
[safe migration execution](docs/migrations.md), [benchmark methodology](docs/benchmarking.md),
[Growth Mode](docs/growth-mode.md), [metric definitions](docs/metrics.md), and the
[roadmap](docs/roadmap.md).

## Known limitations

- Only TypeScript/TSX source is supported.
- Import analysis covers static `import` and `export ... from`; dynamic imports and runtime resolution
  are not modeled.
- Module classification uses normalized paths, package entrypoint fields, and static statement shape; it
  is not responsibility-aware.
- Line counting is lexical and intentionally simple.
- No quality score is produced; metrics require context.
- Symbol clustering uses identifiers and static references, not semantic or runtime behavior.
- A grouped SCC can expose several statically plausible alternatives; their presence is not a claim that
  every alternative is architecturally desirable.
- Extraction impact is estimated because caller rewrites are not simulated.
- Execution supports only approved `extract-module` proposals with low risk, easy reversibility, no
  protected paths, and no predicted public-entrypoint changes.
- Repair suggestions support only additive `approvedCompanionSymbols` changes. Primary-symbol removal,
  destination changes, protected/public declaration movement, shared-module synthesis, and dependency-
  architecture redesign are not suggested or performed.
- Suggestions are deliberately conservative. Ambiguous or unresolved ownership, incomplete legacy
  evidence, budget limits, protected/public surfaces, and cycles that companion additions cannot resolve
  can produce `partial` or `unavailable`, including safe revisions Braid cannot prove from current facts.
- Validation dependencies must already be usable inside the newly created worktree; Braid never runs a
  dependency installation command during migration.
- Candidate branches and commits are local review artifacts. There is no automatic merge or push.
- Validation definitions and their transitively executed scripts are trusted code. Direct Git/network
  executables are rejected, and HEAD, diff, shared refs, and ordinary process-group descendants are
  checked after configured commands finish; this is not an OS sandbox for deliberately detached code.
- Recognizable credential material in changed lines is rejected and omitted from portable patches, but
  this static detector cannot prove that arbitrary application data is non-sensitive.
- `break-cycle` execution and rollback execution remain roadmap work.
- Growth Mode detects only supported static regressions relative to its session baseline; it does not
  guarantee safe or correct code and is not an adversarial security boundary.

## Status

Braid v0.4.0 implements Growth Mode v1 alongside Phase 3.2 deterministic proposal repair suggestions,
Phase 3.1 execution readiness, and safe isolated extraction execution. Growth reports and their Codex
adapter protocol use schema version `1.0.0`; snapshot, proposal, execution-plan, and execution-record
schemas remain version 1.

## License

Braid is available under the [MIT License](LICENSE).
