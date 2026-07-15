# Braid

> Braid continuously restructures growing codebases, weaving new features into healthier architecture while keeping every change verifiable and reversible.

Braid is a continuous architecture evolution tool for growing codebases. It analyzes architectural
drift, helps place new features into appropriate boundaries, and supports incremental, verifiable, and
reversible architecture changes. This hackathon foundation currently implements deterministic analysis
for local TypeScript projects; it does not yet modify code.

## Current scope

Braid scans configured TypeScript and TSX files without executing them, resolves relative and
tsconfig-aliased imports, classifies modules, finds file/module dependency cycles, calculates raw
architecture metrics, and saves validated JSON snapshots under `.braid/state/snapshots/`.

The long-term vision has two modes:

- Growth Mode will assess a feature's architectural impact before implementation and keep prerequisite
  migrations independently reversible.
- Recovery Mode will propose, execute, validate, and roll back small evidence-based migrations for
  existing architectural drift.

Automatic migration, Codex execution, worktrees, and rollback are not implemented yet.

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
```

The example app is intentionally healthy at runtime but architecturally awkward. It contains a
users/orders cycle, mixed notification logic, cross-module imports, a large shared module, and a local
threshold that marks the order service as oversized. Its 24 behavior tests all pass.

## Repository guide

- `apps/cli`: Commander-based `braid` command and console/JSON presentation.
- `packages/core`: Zod domain schemas and validated YAML configuration.
- `packages/analyzer`: TypeScript scanning, import graph, cycle detection, module classification, metrics.
- `packages/store`: atomic JSON project and snapshot persistence.
- `packages/shared`: errors and project-local path constants.
- `examples/bloated-saas`: deterministic integration fixture and runnable TypeScript application.

See [architecture](docs/architecture.md), [metric definitions](docs/metrics.md), and the
[roadmap](docs/roadmap.md).

## Known limitations

- Only TypeScript/TSX source is supported.
- Import analysis covers static `import` and `export ... from`; dynamic imports and runtime resolution
  are not modeled.
- Module classification is directory-based, not responsibility-aware.
- Line counting is lexical and intentionally simple.
- No quality score is produced; metrics require context.
- Migration proposal, execution, validation, and rollback are roadmap work.

## Status

Braid is an unreleased OpenAI Codex hackathon project. Snapshot schema version 1 may evolve before a
public release.
