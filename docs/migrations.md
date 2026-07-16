# Safe migration execution

Phase 3.2 can explain a bounded repair for one `extract-module` proposal that is not execution-ready;
the existing migration path turns only an execution-ready, separately approved proposal into a local,
reviewable candidate. A suggestion is advisory. Braid does not modify, persist, approve, or execute a
suggested revision, and it does not merge, push, open a pull request, execute rollback, or execute
`break-cycle` proposals.

## Safety gate

Every production run requires all of the following:

- the target is a Git repository and its main checkout is clean;
- migration is explicitly enabled and at least one trusted validation command is configured;
- the proposal exists, parses, references the selected snapshot, and is `extract-module`;
- risk is `low`, reversibility is `easy`, and no protected path or public entrypoint is involved;
- the snapshot contains a source fingerprint and its config hash, Git HEAD, and source fingerprint are
  still current;
- `--approve` exactly repeats the proposal ID.

Missing or stale fingerprints instruct the user to rerun `braid analyze` and `braid propose`. `--yes`,
`--force`, `--approve true`, medium/high risk, conditional/difficult reversal, and `break-cycle` are not
overrides.

The source fingerprint is SHA-256 over a sorted tracked-source manifest containing project-relative
path, file type, content hash, and executable bit. Git internals, dependencies, build output, coverage,
caches, and `.braid` runtime artifacts are excluded; source, tests, configuration, manifests, lockfiles,
and entrypoints remain covered.

Snapshots carry separate analysis/planner and migration-configuration hashes. This keeps Phase 2
proposal identities and benchmark fixtures backward-compatible while still rejecting any changed
execution scope, Codex setting, timeout, or validation command before Phase 3 runs. Plans record the
combined execution configuration hash.

## Execution readiness and symbol closure

Before any owned worktree, candidate branch, standalone staging repository, or executor process exists,
the migrator evaluates the approved proposal against declaration/reference/import/module facts in the
selected snapshot. The analyzer supplies facts, the planner continues to own proposal intent and
approved evidence, and the migrator decides only whether that fixed intent is executable.

The closure starts with `target.candidateSymbols`. A same-source declaration needed by a selected
declaration must move because retaining it predicts a destination-to-source dependency while preserved
imports require source-to-destination. Repository-local declarations in other files remain where they
are when import direction is valid; external imports also remain. A local dependency becomes a required
companion when retaining it is not importable or would close a predictable cycle. Closure repeats until
no required companion is added, then repeats the complete calculation and hashes both results.

An updated proposal can explicitly list `approvedCompanionSymbols` by file and symbol. This is approval
evidence, not an instruction to discover more work. `migrate run` never broadens it. A missing approval,
unresolved declaration, reverse edge, predicted cycle, file/symbol budget overflow, protected/public
companion, or unequal repeated closure is `not-ready`. Retained dependencies and legacy snapshot facts
produce visible warnings when otherwise safe. The only states are `ready`, `ready-with-warnings`, and
`not-ready`.

The readiness result uses schema version 1 and records proposal ID, snapshot/config/source fingerprints,
primary and companion symbols, retained/external/unresolved dependencies, predicted import/cycle
evidence, warnings, blockers, and deterministic hashes. New plans embed it without changing execution
plan or execution record schema version; old persisted v1 plans remain readable.

## Advisory repair suggestions

Readiness answers whether the proposal as currently stored and approved is executable. A repair
suggestion answers a different question: whether current repository evidence proves a small,
deterministic addition to `approvedCompanionSymbols` that could make a separately revised proposal
ready. `migrate suggest` reports primary symbols, current approvals, exact proposed additions, symbols
that remain in place, safely imported and unresolved dependencies, predicted import and cycle evidence,
remaining blockers, warnings, and a deterministic reason for every suggested symbol.
The suggestion is derived in memory and is not written to the proposal store or treated as approval.

The repair algorithm begins with the required companion-symbol closure, orders candidates canonically,
and re-evaluates an in-memory clone with the existing readiness algorithm. For an otherwise ready
candidate set, it removes each unnecessary symbol in stable order and retains a symbol only when its
removal would fail readiness or an explicit invariant. Suggestion IDs and symbol order derive from
canonical semantic content rather than timestamps, random values, filesystem traversal order, locale,
or absolute paths. The original proposal object and stored proposal remain unchanged throughout.

Every valid suggestion has exactly one state:

- `actionable`: the minimal bounded additions were re-evaluated in memory and predict `ready` or
  `ready-with-warnings`;
- `partial`: useful evidence changes are known, but one or more blockers would remain; this state is
  never sufficient for execution;
- `unavailable`: Braid cannot safely determine a bounded additive repair from the available evidence.

Phase 3.2's repair boundary is strictly additive. A suggestion may add symbols only to
`approvedCompanionSymbols`; it may not remove primary symbols, change proposal type or destination,
move protected or public-entrypoint declarations, synthesize a shared module, redesign dependencies,
change risk or reversibility, or weaken scope, readiness, validation, or architecture gates. A repair
that requires any such action is `partial` or `unavailable` rather than an unsafe `actionable` result.

Generating an actionable suggestion does not change the original `not-ready` proposal. Running
`migrate run` with that original proposal ID continues to stop with readiness exit code 13 before any
executor or execution resource exists. Execution requires a separately stored revised proposal that
contains the approved companion symbols, passes readiness again, and is explicitly approved using that
revised proposal's own ID. A suggestion ID is never an approval token.

## Deterministic plan and isolated worktree

`planId` hashes normalized proposal identity/content, base commit, source fingerprint, configuration
hash, scope-policy version, validation configuration, executor configuration, and migrator version. It
contains no timestamp, random value, or absolute path. Repeated identical inputs produce the same plan;
each attempt receives a new `E-<uuid>` execution ID.

The worktree manager creates `braid/exec/<eight-hex>` from the exact base commit under a dedicated
directory outside the source checkout. It verifies HEAD, cleanliness, and unchanged remote
configuration, then records ownership. Successful and failed candidates are retained until explicit
discard. The manager refuses unknown paths, unexpected branches, unrelated commits, and paths outside
its execution root. It never pushes.

The executor never receives that candidate path. Braid clones the exact base into a disposable
standalone staging repository with `--no-local`, removes its remote, and verifies that its refs, reflogs,
index tree, configuration, and object set remain unchanged. After scope inspection, only approved
regular-file bytes are atomically materialized into the candidate; Braid then compares the candidate's
patch hash and changed-file set with the inspected stage and deletes the stage. A session-detached
executor descendant can therefore only mutate disposable staging data, not the candidate used for
validation and commit.

## Bounded executor

Production uses `codex exec` with an argument array, not a shell command. The baseline is:

```text
codex exec --ephemeral --json --sandbox workspace-write \
  --ask-for-approval never --cd <executor-stage> \
  -c sandbox_workspace_write.network_access=false \
  -c sandbox_workspace_write.exclude_tmpdir_env_var=true \
  -c sandbox_workspace_write.exclude_slash_tmp=true --output-schema <schema> -
```

The adapter first reads `codex exec --help`. It chooses `--cd` or `-C`, and uses
`-c approval_policy="never"` only when that installed CLI lacks the approval flag. Optional model and
reasoning effort are explicit arguments/config values. `danger-full-access`, bypass flags, `--add-dir`,
and `--full-auto` are never used. A normal exit force-cleans the detached process group; timeout uses
TERM followed by KILL after the configured grace period. Network access is explicitly disabled, and
ambient `$TMPDIR` and `/tmp` write grants are removed so that the staging repository remains the only
workspace-write root. A bounded run therefore cannot reach a temp-hosted source/candidate or push a
remote branch.

The deterministic prompt places non-overridable safety rules before inert plan JSON. It names exact
approved primary/companion symbols, retained dependencies, predicted imports, source, destination,
allowed and forbidden paths, changed-file limit, validation commands, and
the structured final-response schema. There is no free-form prompt injection field. Codex's filtered
summary and events are evidence only; Git remains the source of truth. Authentication data, environment
secrets, private paths, full process environment, and hidden reasoning are not persisted.

## Diff, validation, and architecture gates

After execution, Braid verifies that Codex did not commit and inspects Git porcelain v2, binary patch,
name status, numstat, and all untracked files. It records additions/deletions, renames, line counts,
binary changes, symlinks, submodules, mode changes, and a normalized patch hash. Only statically derived
existing files/tests and new files under the approved destination are allowed.

The following always fail:

- any path outside the plan or more changed files than its limit;
- deleted, binary, symlink, submodule, rename-as-delete, or executable-mode changes;
- package manifests, lockfiles, dependency changes, `tsconfig*.json`, `.github/**`, `.env*`, README,
  license, Git metadata, or Braid execution state;
- public entrypoint content/export changes or protected-path changes.
- changed lines containing recognizable credentials, tokens, private keys, or authenticated URLs.

Validation commands come only from `.braid/architecture.yaml`. Each is an executable plus argument
array, working directory, stage, timeout, required flag, and stdout/stderr limits. Shell executables,
direct Git/network tools, process-wrapper executables, inline Node evaluation, `npx`/`bunx`, package-manager
exec/install/update/remove actions, and worktree escapes are rejected. Braid never installs dependencies;
required tools and dependencies must already work in the isolated checkout. Output is captured
separately and truncated at configured byte limits. Timeout always follows TERM with a process-tree
KILL grace step, even if the validation leader exits first. After validation, Braid rejects any commit
or HEAD movement and re-inspects the actual diff.

Configured validation scripts and everything they transitively execute are trusted code. Process-group
termination and post-command Git checks bound ordinary descendants, but they are not an operating-system
security boundary against a deliberately session-detached process.

After required validation passes, Braid analyzes the candidate, stores a portable after snapshot, and
compares selected-symbol relocation, source/destination changes, imports, cycles, oversized facts,
public entrypoints, protected paths, and predicted versus actual impact. Estimate mismatches are explicit
but do not fail by themselves. Remaining source declarations, a missing destination, a new cycle, public
API change, protected-path change, or no intended structural outcome fails architecture validation.

The main checkout's HEAD/symbolic branch, index tree, tracked-source fingerprint, status, local Git
configuration, shared refs, hooks, ignore rules, pseudorefs, reflogs, worktree registry, and Git lock or
temporary files are compared before execution, before candidate commit, and afterward. Only the exact
ref and worktree administration owned by this execution are excluded; another `braid/exec/*` ref is
protected like every other shared ref. Any mutation or unreadable locked state is exit code 11 and
blocks success.

## Candidate commit, artifacts, and discard

Only after scope, validation, architecture, and main-integrity gates pass may Braid create one commit
with command-local identity:

```text
braid: execute <proposal-id>

Braid-Proposal: <proposal-id>
Braid-Execution: <execution-id>
Braid-Plan: <plan-id>
```

The commit is assembled from a temporary Git index with `commit-tree`, and every Git operation in this
step uses an empty command-local `core.hooksPath`; commit, index, and reference-transaction hooks cannot
run. Its normalized patch hash and exact changed-file set must equal the post-validation evidence; the
owned ref is then updated atomically from the approved base, and the final worktree must be clean. This
binds the commit tree to the reviewed diff and prevents a hook or late file change from altering the
candidate.

`--no-commit` retains validated uncommitted changes. Neither path merges or pushes. Atomic portable
artifacts live under `.braid/executions/<execution-id>/`, including plan/record, scope, validation,
architecture snapshots, impact comparison, filtered Codex events/stderr/summary, and candidate patch.
Absolute worktree paths appear only in an ignored `locator.local.json`.

Execution records use schema-enforced status-dependent completeness and a per-execution atomic lock;
an execution must begin at `planned`, terminal transitions cannot race-overwrite one another, and
`succeeded` requires passing validation, complete architecture evidence, final fingerprints, and
artifacts. `discard` requires the exact execution ID in `--confirm`. It verifies ownership and commit
ancestry, removes only that owned worktree and local candidate branch, retains portable reports/patch,
and marks the record `discarded`. The operation is idempotent and can finish safely after interruption
between Git deletion and record persistence.

## CLI

```bash
braid migrate plan <proposal-id> [--json] [--path <project>]
braid migrate suggest <proposal-id> [--json] [--path <project>]
braid migrate run <proposal-id> --approve <proposal-id> \
  [--executor codex] [--model <model>] [--reasoning-effort <value>] \
  [--timeout <milliseconds>] [--json] [--no-commit] [--path <project>]
braid migrate list [--json] [--path <project>]
braid migrate status <execution-id> [--json] [--path <project>]
braid migrate inspect <execution-id> [--path <project>]
braid migrate diff <execution-id> [--path <project>]
braid migrate discard <execution-id> --confirm <execution-id> [--json] [--path <project>]
```

For a `not-ready` proposal, `migrate plan` includes a concise suggestion summary when one is available.
`migrate suggest` provides stable human-readable and JSON representations of the complete advisory
result. `actionable`, `partial`, and valid `unavailable` analyses exit successfully; invalid input and a
missing proposal retain the normal CLI errors. Suggestion analysis creates no staging repository,
worktree, branch, executor process, execution record, or candidate commit.

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

Stable exit codes are 0 success/information, 2 invalid CLI use, 3 approval failure, 4 stale state, 5
unsupported/unsafe proposal, 6 worktree failure, 7 executor failure, 8 scope violation, 9 validation
failure, 10 architecture failure, 11 main-checkout integrity failure, and 12 discard safety refusal.
Exit code 13 is a deterministic execution-readiness rejection; it occurs before worktree/executor
creation and uses failure code `execution-not-ready`.

## Configuration

Migration is backward-compatible and disabled by default. A minimal enabled configuration is:

```yaml
migration:
  enabled: true
  supportedProposalTypes:
    - extract-module
  maximumChangedFiles: 8
  maximumSymbols: 20
  codex:
    executable: codex
    timeoutMs: 900000
    model: null
    reasoningEffort: null
    sandbox: workspace-write
  validation:
    commands:
      - id: typecheck
        stage: typecheck
        executable: pnpm
        arguments: [typecheck]
        workingDirectory: .
        timeoutMs: 120000
        required: true
      - id: test
        stage: unit-test
        executable: pnpm
        arguments: [test]
        workingDirectory: .
        timeoutMs: 180000
        required: true
```

Validation is unavailable when the command list is empty. Braid does not auto-detect or execute
arbitrary package scripts.

## Conservative and unsupported cases

`unavailable` is a valid safety result, not an internal failure. It includes unresolved declarations,
ambiguous symbol ownership, nondeterministic or incomplete legacy evidence, protected/public surfaces,
file or symbol budget violations, cycles that companion additions cannot resolve, and repairs that
require primary-symbol removal or architectural redesign. `partial` may expose useful additions while
making the remaining blockers explicit.

Because suggestions require positive static evidence, some safe revisions may remain `unavailable` when
legacy snapshots or current analyzer facts cannot prove ownership, importability, minimality, or a
cycle-free result. Rerunning analysis can refresh stale or legacy evidence, but Phase 3.2 does not guess,
broaden scope, or substitute an architectural redesign when proof is incomplete.
