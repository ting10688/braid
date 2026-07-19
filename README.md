<p align="center">
  <img src="docs/assets/brand/braid-logo-readme.png" width="180" alt="Braid logo: a mint and off-white woven B on charcoal">
</p>

<h1 align="center">Braid</h1>

<p align="center">
  <strong>Keep architecture healthy while Codex writes code.</strong><br>
  Braid detects architecture regressions inside a live Codex session and safely executes explicitly approved migrations in isolation.
</p>

<p align="center">
  <a href="https://github.com/ting10688/Braid/actions/workflows/ci.yml"><img src="https://github.com/ting10688/Braid/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/ting10688/Braid/releases"><img src="https://img.shields.io/github/v/release/ting10688/Braid?display_name=tag" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ting10688/Braid" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-8EE7BF" alt="Node.js 22 or newer">
</p>

<p align="center">
  <a href="#quick-judge-demo"><strong>Run the deterministic judge demo →</strong></a>
</p>

Braid is a continuous architecture evolution tool for growing codebases. It analyzes architectural
drift, helps place new features into appropriate boundaries, and supports incremental, verifiable, and
reversible architecture changes. Current releases include bounded Growth Mode, the standalone judge
demo, and a Node.js 22 distribution while preserving the existing approval and isolated-execution
boundaries for local TypeScript projects.

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
- Durable migration recovery now resumes or safely cleans up interrupted, explicitly approved isolated
  executions from verified journal evidence. The broader Recovery Mode vision may later add rollback of
  existing architectural drift.

Automatic merge, push, pull-request creation, rollback execution, automatic repair, and `break-cycle`
execution are not implemented. Braid never autonomously applies a proposal to the main checkout.

## Requirements and installation

The v0.6 native-agent workflow is:

1. Install the Braid CLI once.
2. Choose Codex, Gemini CLI, or local GitHub Copilot CLI and install its native
   Braid plugin or extension.
3. Run `$braid:setup` in Codex or `/braid:setup` in Gemini/Copilot.
4. Run `braid init` in the TypeScript project if it is not initialized.
5. Review `.braid/architecture.yaml` and explicitly enable Growth Mode.
6. Use the coding agent normally; native lifecycle hooks run Braid
   automatically.

Native adapters do not download Braid, initialize a project, enable Growth
Mode, or grant host trust. The local Codex, Gemini, and Copilot package smokes
have passed, but remote marketplace/extension commands remain unreleased and
pending a post-push smoke. See the
[native agent plugin guide](docs/native-agent-plugins.md) for exact verified
local commands, host limitations, uninstall, and troubleshooting. Claude Code
support is deferred and is not included in the current release. Completed
compatibility research is preserved for a future implementation cycle in the
[compatibility report](docs/agent-compatibility.md).

```bash
curl -fsSL https://raw.githubusercontent.com/ting10688/Braid/main/install.sh | sh
```

The installer supports macOS arm64, macOS x86_64, and Linux x86_64. It requires Node.js 22 or newer
and Git 2.39 or newer, installs without `sudo`, and does not require pnpm, `node_modules`, a source
checkout, or knowledge of the monorepo. By default it installs versions under
`${XDG_DATA_HOME:-$HOME/.local/share}/braid` and links `braid` into
`${XDG_BIN_HOME:-$HOME/.local/bin}`.

To inspect the installer before running it:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/ting10688/Braid/main/install.sh \
  -o install-braid.sh

less install-braid.sh
sh install-braid.sh
```

After opening a new shell, or immediately when the selected bin directory is already in `PATH`:

```bash
braid --version
braid --help
```

See the [installation guide](docs/installation.md) for version pinning, custom directories, PATH
behavior, upgrades, explicit downgrades, uninstall, checksum verification, manual archive use, and
source-development setup.

The existing manual Codex adapter remains available as a compatibility
fallback:

```bash
braid growth install codex --confirm
```

Do not install both the manual adapter and native Codex plugin. If both are
detected, run `braid growth uninstall codex` to keep only the native plugin.

### Quick judge demo

Download the `braid-v<version>-demo-node22` archive for a stable release, extract it, and run:

```bash
./braid-demo
```

The deterministic path needs Node.js 22 and Git 2.39 or newer. It needs no OpenAI account, Codex
login, pnpm installation, source build, or network access. On platforms without the shell launcher,
run `node ./demo/run-demo.mjs`. See the [judge guide](demo/growth-mode-live-guard/README.md) for the
scenario, expected output, `--keep`, and the optional live-Codex path.

### Prebuilt CLI

The same versioned archive contains the standalone CLI. After extracting it, run:

```bash
./bin/braid --help
```

Windows Command Prompt can use `bin\braid.cmd --help`; `node ./bin/braid.mjs --help` works anywhere
Node.js 22 is available. The CLI bundle does not need pnpm, `node_modules`, or a repository checkout.

### Development from source

Use the package-manager version pinned by this repository:

```bash
git clone <repository-url> braid
cd braid
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm braid --help
```

A global CLI link remains an optional developer convenience:

```bash
pnpm --filter @braid/cli link --global
```

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
braid migrate recover E-00000000-0000-4000-8000-000000000001
braid migrate resume E-00000000-0000-4000-8000-000000000001 \
  --confirm E-00000000-0000-4000-8000-000000000001
braid migrate cleanup E-00000000-0000-4000-8000-000000000001 \
  --confirm E-00000000-0000-4000-8000-000000000001
braid migrate discard E-00000000-0000-4000-8000-000000000001 \
  --confirm E-00000000-0000-4000-8000-000000000001
```

Migration is disabled by default. The project configuration must explicitly enable it and provide
trusted executable-plus-argument validation commands. `run` accepts only the production `codex`
executor, requires the exact proposal ID in `--approve`, and supports `--model`,
`--reasoning-effort`, `--timeout`, `--json`, and `--no-commit`. It never merges or pushes. See the
[migration safety and lifecycle guide](docs/migrations.md) and
[durable recovery protocol](docs/durable-migration-recovery.md).

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
pnpm benchmark:recovery
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
  readiness and advisory repair evaluation, durable recovery, validation, architecture comparison, and
  candidate commits.
- `packages/guard`: session baselines, Git/source fingerprints, architecture comparison, bounded
  feedback, ephemeral state, and the Codex hook adapter.
- `packages/store`: atomic JSON project, snapshot, proposal, execution-record, and immutable recovery
  journal persistence.
- `packages/benchmark`: independent fixture isolation, repeated evaluation, regression policies, baselines,
  iteration comparison, recovery interruption coverage, and reports.
- `packages/shared`: errors and project-local path constants.
- `benchmarks`: versioned synthetic and pinned real-world suites, reviewed expectations, fixture templates,
  repository metadata, and ignored run results.
- `examples/bloated-saas`: deterministic integration fixture and runnable TypeScript application.

See [architecture](docs/architecture.md), [proposal behavior](docs/proposals.md),
[safe migration execution](docs/migrations.md), [benchmark methodology](docs/benchmarking.md),
[durable migration recovery](docs/durable-migration-recovery.md), [Growth Mode](docs/growth-mode.md),
[metric definitions](docs/metrics.md), and the
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
- Durable recovery is local and single-host. It cannot recover across machines, acts only on resources
  with verified Braid ownership, and may leave unreachable Git objects created before a process crash.
- Growth Mode detects only supported static regressions relative to its session baseline; it does not
  guarantee safe or correct code and is not an adversarial security boundary.

## Status

Braid v0.5.1 adds verified installation and owned lifecycle management for the existing standalone
distribution. Phase 4 durable migration recovery, Growth Mode v1, deterministic proposal repair
suggestions, execution readiness, and safe isolated extraction behavior are unchanged. Recovery
journals use schema version `1.0.0`; Growth reports and their Codex adapter protocol remain at `1.0.0`,
while snapshot, proposal, execution-plan, and execution-record schemas remain version 1.

## License

Braid is available under the [MIT License](LICENSE).
