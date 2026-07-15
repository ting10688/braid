# Braid

> Braid continuously restructures growing codebases, weaving new features into healthier architecture while keeping every change verifiable and reversible.

Braid is a continuous architecture evolution tool for growing codebases. It analyzes architectural
drift, helps place new features into appropriate boundaries, and supports incremental, verifiable, and
reversible architecture changes. Version 0.2 adds deterministic migration proposals for local
TypeScript projects. Braid still does not modify analyzed source code or execute migrations.

## Current scope

Braid scans configured TypeScript and TSX files without executing them, resolves relative and
tsconfig-aliased imports, classifies modules, finds file/module dependency cycles, calculates raw
architecture metrics, and saves validated JSON snapshots under `.braid/state/snapshots/`.
It can then generate evidence-backed `break-cycle` and `extract-module` proposals and atomically save
them under `.braid/state/proposals/`.

The long-term vision has two modes:

- Growth Mode will assess a feature's architectural impact before implementation and keep prerequisite
  migrations independently reversible.
- Recovery Mode will propose, execute, validate, and roll back small evidence-based migrations for
  existing architectural drift.

Migration execution, Codex runtime integration, worktrees, and rollback execution are not implemented.

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
Neither third-party repository is vendored or used as a Braid source dependency.

The example app is intentionally healthy at runtime but architecturally awkward. It contains a
users/orders cycle, mixed notification logic, cross-module imports, a large shared module, and a local
threshold that marks the order service as oversized. Its 24 behavior tests all pass.

## Repository guide

- `apps/cli`: Commander-based `braid` command and console/JSON presentation.
- `packages/core`: Zod domain schemas and validated YAML configuration.
- `packages/analyzer`: TypeScript scanning, import graph, cycle detection, module classification, metrics.
- `packages/planner`: pure deterministic candidate generation, classification, identity, and ranking.
- `packages/store`: atomic JSON project, snapshot, and proposal persistence.
- `packages/benchmark`: independent fixture isolation, repeated evaluation, regression policies, baselines,
  iteration comparison, and reports.
- `packages/shared`: errors and project-local path constants.
- `benchmarks`: versioned synthetic and pinned real-world suites, reviewed expectations, fixture templates,
  repository metadata, and ignored run results.
- `examples/bloated-saas`: deterministic integration fixture and runnable TypeScript application.

See [architecture](docs/architecture.md), [proposal behavior](docs/proposals.md),
[benchmark methodology](docs/benchmarking.md), [metric definitions](docs/metrics.md), and the
[roadmap](docs/roadmap.md).

## Known limitations

- Only TypeScript/TSX source is supported.
- Import analysis covers static `import` and `export ... from`; dynamic imports and runtime resolution
  are not modeled.
- Module classification is directory-based, not responsibility-aware.
- Line counting is lexical and intentionally simple.
- No quality score is produced; metrics require context.
- Symbol clustering uses identifiers and static references, not semantic or runtime behavior.
- Extraction impact is estimated because caller rewrites are not simulated.
- Migration execution, validation, and rollback execution remain roadmap work.

## Status

Braid is an unreleased OpenAI Codex hackathon project. Snapshot schema version 1 may evolve before a
public release.
