<p align="center">
  <img src="docs/assets/brand/braid-logo-readme.png" width="180" alt="Braid logo: a mint and off-white woven B on charcoal">
</p>

<h1 align="center">Braid</h1>

<p align="center">
  <strong>Keep architecture healthy while Codex writes code.</strong><br>
  Analyze structure, generate reviewable proposals, guard coding sessions, and execute approved migrations in isolation.
</p>

<p align="center">
  <a href="https://github.com/ting10688/Braid/actions/workflows/ci.yml"><img src="https://github.com/ting10688/Braid/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/ting10688/Braid/releases"><img src="https://img.shields.io/github/v/release/ting10688/Braid?display_name=tag" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ting10688/Braid" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-8EE7BF" alt="Node.js 22 or newer">
</p>

<p align="center">
  <a href="#installation"><strong>Install</strong></a>
  ·
  <a href="#quick-start"><strong>Quick start</strong></a>
  ·
  <a href="#growth-mode"><strong>Growth Mode</strong></a>
  ·
  <a href="#demo"><strong>Demo</strong></a>
  ·
  <a href="#documentation"><strong>Documentation</strong></a>
</p>

Braid is a local architecture guard and migration planner for growing TypeScript codebases.

It analyzes dependency structure without executing application source, turns architectural findings into deterministic and reviewable proposals, and helps prevent supported architecture regressions from being left behind during supported coding-agent sessions.

When an approved migration is executed, Braid works inside isolated, owned Git resources. It validates the resulting diff, compares the architecture, and produces a local candidate commit for review. It never automatically merges or pushes changes.

## What Braid does

| Capability  | Result                                                                |
| ----------- | --------------------------------------------------------------------- |
| **Analyze** | Build a deterministic snapshot of the current architecture            |
| **Propose** | Generate evidence-backed `break-cycle` and `extract-module` proposals |
| **Guard**   | Detect supported regressions introduced during an agent session       |
| **Migrate** | Execute explicitly approved extraction proposals in isolation         |
| **Recover** | Resume or safely clean up interrupted Braid-owned executions          |

Braid is designed around explicit approval, deterministic evidence, bounded automation, and reviewable outputs.

## Installation

Install the latest stable release:

The current release is v0.6.0. Its native-agent workflow is:

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
have passed. Remote owner/repository installation works only after the plugin
content exists on the repository's default branch; release validation tests
those paths after merge. See the
[native agent plugin guide](docs/native-agent-plugins.md) for exact verified
local commands, host limitations, uninstall, and troubleshooting. Claude Code
support is deferred and is not included in the current release. Completed
compatibility research is preserved for a future implementation cycle in the
[compatibility report](docs/agent-compatibility.md).

```bash
curl -fsSL https://raw.githubusercontent.com/ting10688/Braid/main/install.sh | sh
```

Then open a new shell and verify the installation:

```bash
braid --version
braid --help
```

### Requirements

- Node.js 22 or newer
- Git 2.39 or newer
- macOS arm64, macOS x86_64, or Linux x86_64

The installer:

- installs without `sudo`;
- verifies release checksums;
- does not require pnpm or a repository clone;
- keeps versioned installations;
- supports safe upgrades and explicit downgrades;
- manages only paths recorded as Braid-owned.

To inspect the installer before running it:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/ting10688/Braid/main/install.sh \
  -o install-braid.sh

less install-braid.sh
sh install-braid.sh
```

See the [installation guide](docs/installation.md) for custom directories, version pinning, PATH behavior, upgrades, downgrades, checksum verification, manual archive use, Windows instructions, and uninstalling.

## Quick start

Run Braid inside an existing TypeScript project:

```bash
cd path/to/your-project

braid init
braid analyze
braid propose
```

This creates project-local configuration and state under `.braid/`.

```text
.braid/
├── architecture.yaml
├── state/
│   ├── project.json
│   ├── snapshots/
│   └── proposals/
└── executions/
```

The basic workflow is:

1. `braid init` creates the project configuration.
2. `braid analyze` records a deterministic architecture snapshot.
3. `braid propose` analyzes the latest state and creates reviewable proposals.

These commands do not rewrite application source code.

For an analysis without saving a snapshot:

```bash
braid analyze --no-save
```

For proposals without saving snapshots or proposal files:

```bash
braid propose --no-save
```

For machine-readable output:

```bash
braid analyze --json
braid propose --json
```

## Typical workflow

### 1. Analyze the project

```bash
braid analyze
```

Braid scans configured TypeScript and TSX files, resolves supported relative and tsconfig-aliased imports, classifies modules, detects cycles, calculates architecture metrics, and saves a validated snapshot.

Example output:

```text
Braid analysis

Project: /path/to/project
Source files: 42
Modules: 8
Internal imports: 91
External imports: 24
Cross-module imports: 17
Circular dependencies: 1 [warning]
Oversized files: 2 [warning]

Snapshot: S-...
Saved: .braid/state/snapshots/S-....json
```

### 2. Generate proposals

```bash
braid propose
```

Limit or filter the results when needed:

```bash
braid propose --limit 1
braid propose --type extract-module
braid propose --type break-cycle
```

Braid currently generates:

- `break-cycle` proposals for deterministic dependency-cycle root causes;
- `extract-module` proposals for statically identified responsibility clusters.

Proposal generation is advisory. It does not edit source, tests, manifests, or TypeScript configuration.

### 3. Inspect migration readiness

Choose a proposal ID from the output:

```bash
braid migrate plan <proposal-id>
```

The plan reports one of:

- `ready`
- `ready-with-warnings`
- `not-ready`

Readiness analysis includes required companion symbols, retained dependencies, external dependencies, unresolved references, predicted import direction, and cycle risks.

A `not-ready` proposal is rejected before Braid creates a worktree, staging repository, branch, executor process, or candidate commit.

For an advisory repair suggestion:

```bash
braid migrate suggest <proposal-id>
```

Suggestions may identify a minimal addition to `approvedCompanionSymbols`, but they never modify or approve the original proposal.

### 4. Execute an approved migration

Migration execution is disabled by default. It must be explicitly enabled in `.braid/architecture.yaml`, including trusted validation commands.

Only supported low-risk, easy-reversibility `extract-module` proposals are currently executable.

```bash
braid migrate run <proposal-id> --approve <proposal-id>
```

The exact proposal ID must be repeated through `--approve`.

A successful run:

1. verifies readiness;
2. creates Braid-owned isolated Git resources;
3. runs the bounded Codex executor in a disposable staging repository;
4. inspects the resulting diff independently;
5. runs configured validation;
6. compares the resulting architecture;
7. creates one local candidate commit.

Braid never merges or pushes the candidate.

See the [migration guide](docs/migrations.md) for configuration, approval, validation, execution records, retained patches, and cleanup.

## Growth Mode

Growth Mode brings Braid into ordinary Codex, Gemini CLI, and local GitHub
Copilot CLI coding sessions.

It captures a baseline when a session starts, evaluates architecture after relevant source changes, returns concise findings to the same session, and performs a bounded final check before the agent finishes.

Install the selected native plugin or extension, initialize the project, and
explicitly enable `growthMode` in `.braid/architecture.yaml`. See the
[native agent plugin guide](docs/native-agent-plugins.md) for exact Codex,
Gemini, and Copilot installation commands and host-specific trust or restart
requirements.

The existing repository-local Codex adapter remains available as a manual
fallback:

```bash
braid growth install codex --dry-run
braid growth install codex --confirm
```

Do not install both Codex adapters. If both are detected, keep the native
plugin by running:

```bash
braid growth uninstall codex
```

Open Codex in the repository and review the exact hook definitions with:

```text
/hooks
```

Useful Growth Mode commands:

```bash
braid growth context
braid growth check --session <session-id>
braid growth final --session <session-id>
braid growth status --session <session-id>
braid growth reset --session <session-id> --confirm <session-id>
```

To remove only Braid-owned Codex hook handlers:

```bash
braid growth uninstall codex
```

Growth Mode:

- compares the current working tree with the session baseline;
- reports newly introduced supported regressions;
- separates pre-existing findings from session changes;
- uses bounded final-stop behavior;
- caches unchanged states;
- does not edit source;
- does not invoke migration execution;
- does not create commits, branches, or worktrees.

The v0.6.0 production host scope is Codex, Gemini CLI, and local GitHub Copilot
CLI. Copilot cloud-agent support is not claimed. Claude Code production support
is deferred.

See the [Growth Mode guide](docs/growth-mode.md) for lifecycle behavior, hook ownership, finite blocking, caching, configuration, and limitations.

## Safety model

Braid separates analysis, approval, execution, and integration.

### Analysis and proposals

`analyze`, `propose`, and proposal-repair suggestions never modify application source.

### Explicit execution approval

Migration execution requires:

- migration support enabled in project configuration;
- a supported proposal type;
- acceptable risk and reversibility;
- passing readiness checks;
- the exact proposal ID repeated through `--approve`;
- configured validation commands.

### Isolated execution

The main checkout is not used as the executor workspace.

Braid uses:

- an owned external Git worktree;
- a disposable remote-free staging repository;
- a bounded Codex process;
- independent patch and scope inspection;
- validation and architecture gates;
- a local candidate branch and commit.

### No automatic integration

Braid does not automatically:

- merge;
- push;
- open a pull request;
- rewrite the main checkout;
- execute `break-cycle` proposals;
- roll back existing architectural drift.

### Trusted local boundary

Braid validates ownership, paths, diffs, refs, configured commands, and supported process behavior, but it is not an operating-system security sandbox.

Validation commands and their transitively executed scripts are trusted local code.

## Core capabilities

### Static architecture analysis

Braid currently analyzes configured TypeScript and TSX files.

It supports:

- static `import` declarations;
- static `export ... from` declarations;
- relative imports;
- supported tsconfig aliases;
- module classification;
- public entrypoint detection;
- cross-module dependency analysis;
- strongly connected dependency components;
- file and module size metrics;
- deterministic JSON snapshots.

Application source is parsed but not executed.

### Deterministic proposals

Braid produces evidence-backed proposals with:

- stable identities;
- risk and reversibility classifications;
- expected architecture impact;
- source evidence;
- one ranked primary cycle action;
- typed alternatives where applicable;
- deterministic ordering.

### Execution readiness

Before launching an executor, Braid evaluates symbol dependency closure and predicts whether an extraction can be performed without introducing prohibited reverse dependencies or cycles.

Incomplete proposals fail before execution resources are created.

### Advisory proposal repair

For supported `not-ready` extraction proposals, Braid can suggest the smallest bounded addition to `approvedCompanionSymbols`.

Suggestions are:

- additive only;
- deterministic;
- advisory;
- never automatically persisted;
- never treated as approval.

### Durable recovery

Braid records immutable, integrity-checked migration checkpoints.

After interruption, a fresh process can classify an execution as:

- `resumable`
- `cleanup-required`
- `already-complete`
- `unsafe-to-resume`
- `manual-inspection-required`

Inspect recovery state:

```bash
braid migrate recover
braid migrate recover <execution-id>
```

Resume verified work:

```bash
braid migrate resume <execution-id> --confirm <execution-id>
```

Clean up only verified Braid-owned resources:

```bash
braid migrate cleanup <execution-id> --confirm <execution-id>
```

Durable recovery does not guess ambiguous executor state and does not relaunch completed executor work.

See the [durable recovery protocol](docs/durable-migration-recovery.md).

## CLI reference

| Command                        | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `braid init`                   | Create project-local configuration and state             |
| `braid analyze`                | Create a deterministic architecture snapshot             |
| `braid propose`                | Generate deterministic migration proposals               |
| `braid migrate plan`           | Evaluate migration readiness without creating a worktree |
| `braid migrate suggest`        | Generate an advisory repair suggestion                   |
| `braid migrate run`            | Execute an explicitly approved migration in isolation    |
| `braid migrate list`           | List migration execution records                         |
| `braid migrate status`         | Show one execution status                                |
| `braid migrate inspect`        | Show the portable plan and execution record              |
| `braid migrate diff`           | Show a retained candidate patch                          |
| `braid migrate recover`        | Inspect durable recovery state                           |
| `braid migrate resume`         | Resume a verified interrupted execution                  |
| `braid migrate cleanup`        | Remove verified Braid-owned recovery resources           |
| `braid migrate discard`        | Remove an execution-owned worktree and branch            |
| `braid growth context`         | Initialize or show session architecture guidance         |
| `braid growth check`           | Evaluate changes relative to a session baseline          |
| `braid growth final`           | Apply the bounded final-session policy                   |
| `braid growth status`          | Show session and adapter status                          |
| `braid growth reset`           | Reset Braid-owned state for one session                  |
| `braid growth install codex`   | Install the repository-local Codex adapter               |
| `braid growth uninstall codex` | Remove only Braid-owned Codex handlers                   |

Run the built-in help for complete options:

```bash
braid --help
braid migrate --help
braid growth --help
```

<details>
<summary><strong>Advanced command examples</strong></summary>

### Initialization

```bash
braid init
braid init path/to/project
braid init --force
```

### Analysis

```bash
braid analyze
braid analyze --json
braid analyze --no-save
```

### Proposals

```bash
braid propose
braid propose --json
braid propose --no-save
braid propose --limit 1
braid propose --type extract-module
braid propose --type break-cycle
braid propose --snapshot <snapshot-id>
```

### Migration lifecycle

```bash
braid migrate plan <proposal-id>
braid migrate suggest <proposal-id>
braid migrate run <proposal-id> --approve <proposal-id>

braid migrate list
braid migrate status <execution-id>
braid migrate inspect <execution-id>
braid migrate diff <execution-id>

braid migrate recover <execution-id>
braid migrate resume <execution-id> --confirm <execution-id>
braid migrate cleanup <execution-id> --confirm <execution-id>
braid migrate discard <execution-id> --confirm <execution-id>
```

### Growth Mode

```bash
braid growth install codex --dry-run
braid growth install codex --confirm

braid growth context
braid growth check --session <session-id>
braid growth final --session <session-id>
braid growth status --session <session-id>
braid growth reset --session <session-id> --confirm <session-id>

braid growth uninstall codex
```

</details>

## Demo

A deterministic Growth Mode demo is included in every stable standalone distribution.

Download and extract the `braid-v<version>-demo-node22` archive from GitHub Releases, then run:

```bash
./braid-demo
```

The demo:

1. creates a disposable healthy TypeScript repository;
2. captures a Growth Mode baseline;
3. verifies an initial pass;
4. introduces a labeled dependency cycle;
5. runs the real bundled Growth Mode implementation;
6. reports a block;
7. applies a labeled repair;
8. reports a final pass;
9. verifies that Braid made no source or Git mutation;
10. cleans up automatically.

The deterministic path requires no OpenAI account, Codex login, pnpm installation, source build, or network connection after extraction.

Cross-platform entrypoint:

```bash
node ./demo/run-demo.mjs
```

See the [demo guide](demo/growth-mode-live-guard/README.md) for expected output, retained temporary state with `--keep`, and the optional live-Codex walkthrough.

## Other installation methods

### Prebuilt CLI archive

The stable release archive contains the standalone CLI:

```bash
./bin/braid --version
./bin/braid --help
```

On Windows:

```bat
bin\braid.cmd --help
```

Cross-platform Node entrypoint:

```bash
node ./bin/braid.mjs --help
```

The standalone CLI does not require pnpm, `node_modules`, workspace packages, or a source checkout.

### Development from source

Use the package-manager version pinned by the repository:

```bash
git clone https://github.com/ting10688/Braid.git
cd Braid

corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm braid --help
```

An optional contributor-only global link can be created after building:

```bash
pnpm --filter @braid/cli link --global
```

Source development is separate from the supported standalone end-user installation channel.

## Documentation

- [Installation](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Proposal behavior](docs/proposals.md)
- [Safe migration execution](docs/migrations.md)
- [Durable migration recovery](docs/durable-migration-recovery.md)
- [Growth Mode](docs/growth-mode.md)
- [Benchmark methodology](docs/benchmarking.md)
- [Metric definitions](docs/metrics.md)
- [Roadmap](docs/roadmap.md)

## Current scope and limitations

- Only TypeScript and TSX source is currently supported.
- Import analysis models static imports and static re-exports, not dynamic runtime resolution.
- Module classification is based on paths, package entrypoints, and static statement shape.
- Symbol clustering uses identifiers and static references rather than semantic runtime behavior.
- Metrics provide evidence, not a universal architecture quality score.
- Extraction impact remains partly estimated because all downstream caller rewrites are not simulated during proposal generation.
- Migration execution supports only eligible `extract-module` proposals.
- `break-cycle` proposals are advisory and cannot currently be executed.
- Repair suggestions support only additive `approvedCompanionSymbols` changes.
- Validation dependencies must already be available in the isolated worktree.
- Candidate branches and commits remain local review artifacts.
- Durable recovery is local and single-host.
- Growth Mode detects supported static regressions relative to a session baseline.
- Growth Mode does not prove that code is correct or secure.
- Braid is not an adversarial security boundary.

The project deliberately refuses unsupported or ambiguous operations instead of guessing.

## Development

Common contributor commands:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format
pnpm braid --help
```

Useful example and benchmark commands:

```bash
pnpm analyze:example
pnpm propose:example

pnpm benchmark:smoke
pnpm benchmark:regression
pnpm benchmark:real:regression
pnpm benchmark:migration:regression
pnpm benchmark:readiness
pnpm benchmark:repair-suggestions
pnpm benchmark:growth-mode
pnpm benchmark:recovery
```

Braid Bench freezes protocol, suite, expectation, fixture, configuration, repetition, and timeout inputs before comparing executables. It records immutable manifests and separates correctness, stability, and cost evidence.

See the [benchmark methodology](docs/benchmarking.md).

## Repository guide

| Path                    | Responsibility                                                                   |
| ----------------------- | -------------------------------------------------------------------------------- |
| `apps/cli`              | CLI commands and human/JSON presentation                                         |
| `packages/core`         | Domain schemas and validated architecture configuration                          |
| `packages/analyzer`     | TypeScript scanning, dependency graphs, classification, and metrics              |
| `packages/planner`      | Deterministic candidate generation, identity, classification, and ranking        |
| `packages/migrator`     | Readiness, isolated execution, validation, candidate commits, and recovery       |
| `packages/guard`        | Session baselines, architecture comparison, bounded feedback, and agent adapters |
| `packages/store`        | Atomic snapshots, proposals, execution records, and recovery journals            |
| `packages/benchmark`    | Isolated fixtures, comparisons, baselines, and regression reports                |
| `packages/shared`       | Shared errors and project-local path constants                                   |
| `benchmarks`            | Versioned synthetic and pinned real-world benchmark suites                       |
| `examples/bloated-saas` | Deterministic integration fixture and example application                        |

## Status

Braid v0.6.0 adds native Growth Mode integrations for Codex, Gemini CLI, and local GitHub Copilot CLI
while preserving the manual Codex fallback and verified standalone distribution. Claude Code
production support is deferred. Authenticated package-level live-agent smoke has not been performed.
Recovery journals use schema version `1.0.0`; Growth reports and their adapter protocol remain at
`1.0.0`, while snapshot, proposal, execution-plan, and execution-record schemas remain version 1.

## License

Braid is available under the [MIT License](LICENSE).
