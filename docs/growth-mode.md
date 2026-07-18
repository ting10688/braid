# Growth Mode

Growth Mode is Braid's live architecture feedback loop for ordinary Codex, Gemini CLI, and local GitHub Copilot CLI coding sessions. It records
the repository architecture visible at the beginning of one session, compares later working-tree
states with that baseline, and reports only supported regressions introduced during the session.

Growth Mode does not guarantee correct or safe code. It detects a bounded set of static TypeScript
architecture changes relative to the session baseline.

## Growth Mode and migration execution

Growth Mode observes the user's current working tree. It never creates a proposal, staging repository,
candidate branch, worktree, commit, merge, push, or nested Codex execution. It does not repair source
code. Its normal `context`, `check`, `final`, and hook operations write only worktree-specific ephemeral
state inside the Git directory.

Migration execution remains a separate explicitly approved workflow. It starts from one stored
proposal, creates isolated execution resources, validates a candidate, and may create one local
candidate commit. Growth Mode does not call that orchestrator.

## Configuration

Growth Mode is disabled when `growthMode` is absent, preserving behavior for existing Braid projects.
An explicit section can enable the bounded v1 policy:

```yaml
growthMode:
  enabled: true
  enforcement: block
  blockOn:
    - new-cycle
  warnOn:
    - oversized-threshold-crossed
    - oversized-module-growth
  maxFindings: 5
  maxFeedbackCharacters: 4000
  stopBlocksPerFingerprint: 1
```

`enforcement: warn` reports a new cycle but allows Codex to complete at its first Stop attempt.
`enforcement: block` applies the configured, finite Stop behavior. Growth Mode v1 deliberately has no
general policy language or configurable dependency-boundary language.

Reports expose exactly three statuses:

- `pass`: no new supported architecture regression;
- `warn`: a supported non-blocking regression or incomplete analyzer evidence exists;
- `block`: a configured hard regression, currently `new-cycle`, exists.

A pre-existing cycle or oversized module is part of the baseline and does not block unrelated work.
Crossing an oversized threshold or growing an already oversized module can warn. Removing a
pre-existing problem is an improvement. Repairing a new problem during the session returns the current
state to `pass`.

## Baseline and change detection

`SessionStart` captures the baseline once. `UserPromptSubmit` lazily creates it if the start hook was
unavailable. Later source changes never replace a valid baseline; only an explicitly confirmed
`growth reset` removes Braid-owned session state.

The baseline includes the working-tree content visible when the session begins, including ordinary
staged or unstaged edits and supported untracked TypeScript files. State is keyed by session and the current Git worktree and is stored under that
worktree's Git directory, so it does not appear in `git status` or leak into another linked worktree.
Portable reports contain only repository-relative paths and hashed repository/worktree identities.

Before scanning, the guard hashes current HEAD, the relevant staged index diff, relevant source and
configuration content, and supported untracked TypeScript files. Tool names are not treated as proof of mutation. If that cheap
fingerprint is unchanged, Braid skips the analyzer, reuses the latest result, and sends no duplicate
feedback. A changed source, configuration, baseline, HEAD, or worktree identity invalidates the cached
result.

Growth Mode v1 uses the existing deterministic full-repository analyzer after a relevant change. It
focuses findings on changed files, importers, participating cycle files, import edges, and affected
module metrics. It does not run builds, tests, linters, dependency installation, migration execution,
or Codex after each tool call.

## Native lifecycle adapters

The v0.6 native packages translate three verified command-hook protocols into
one Braid lifecycle:

| Braid lifecycle | Codex              | Gemini CLI     | Copilot CLI           | Braid behavior                                                                            |
| --------------- | ------------------ | -------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| session start   | `SessionStart`     | `SessionStart` | `sessionStart`        | Initialize once and add concise baseline context.                                         |
| prompt submit   | `UserPromptSubmit` | `BeforeAgent`  | `userPromptSubmitted` | Lazily initialize when needed; Copilot prompt stdout stays empty.                         |
| post mutation   | `PostToolUse`      | `AfterTool`    | `postToolUse`         | Fingerprint current Git/files and add bounded feedback only after a relevant change.      |
| final stop      | `Stop`             | `AfterAgent`   | `agentStop`           | Run the authoritative final scan; allow pass/warn or block once for a unique fingerprint. |

For a configured block, the first final-stop attempt returns the exact finding and corrective guidance as a
native continuation reason. Each unique diff-and-finding fingerprint is continued no more than
`stopBlocksPerFingerprint` times. A repeated unchanged Stop is allowed with a visible unresolved
warning, and the ephemeral state records that outcome. A source change creates a new evaluation and
retry identity. This prevents an infinite Stop loop.

Codex and Gemini require their normal hook/folder trust review. Installation
cannot grant that trust. Tool-event coverage is not a complete interception
boundary for every shell path, so Braid reads Git and current files again at
the final event. Copilot support is local CLI only; no cloud coding-agent
compatibility is claimed.

## CLI and installation

The preferred v0.6 workflow is to install Braid once, install the selected
host's native package, invoke its `setup` or `status` command, initialize the
project, explicitly enable Growth Mode, and then use the host normally. Native
package installation does not run `braid init`, enable Growth Mode, grant
trust, or download Braid. See [native agent plugins](native-agent-plugins.md)
for the verified local commands and post-push remote status.

The native command names are `$braid:setup`, `$braid:status`, `$braid:check`,
and `$braid:help` in Codex, and `/braid:setup`, `/braid:status`,
`/braid:check`, and `/braid:help` in Gemini and Copilot. Their underlying CLI
inspection commands are:

```console
$ braid growth setup --host codex
$ braid growth status --host codex
$ braid growth setup --host gemini
$ braid growth status --host gemini
$ braid growth setup --host copilot
$ braid growth status --host copilot
```

The manual Codex adapter remains a compatibility fallback:

```console
$ braid growth install codex --dry-run
$ braid growth install codex --confirm
$ codex
```

It probes the active Codex binary and structurally merges four Braid-owned
repository-local handlers into `.codex/hooks.json`. A real install requires
`--confirm`; unrelated keys, matcher groups, and handlers are preserved.
Changing an existing file creates a content-addressed backup and repeating the
same install is a no-op. If both native and manual Codex adapters are present,
the native invocation fails open and reports
`braid growth uninstall codex`.

Remove only Braid-owned handlers with:

```console
$ braid growth uninstall codex --dry-run
$ braid growth uninstall codex
```

The uninstall is idempotent and preserves every unrelated hook. It does not remove user trust records.

Other commands accept `--path` and, where session state matters, `--session`:

```console
$ braid growth context --json
$ braid growth check --session my-session
$ braid growth check --session my-session --json
$ braid growth final --session my-session
$ braid growth status --session my-session --json
$ braid growth reset --session my-session --confirm my-session
```

`context` prints agent-ready guidance. `check` evaluates the current state. `final` applies the same
finite policy as `Stop` without editing the repository. `status` includes baseline/cache state,
installation ownership, and detected Codex capabilities. `reset` requires the exact session ID and
removes only that session's Braid-owned ephemeral state.

## Example feedback loop

```text
Braid session context:
- no dependency cycles
- notification-service.ts is near the oversized threshold

[Codex edits files]

BRAID LIVE GUARD — BLOCK
New dependency cycle: notifications -> orders -> notifications

Introduced dependency:
src/modules/notifications/service.ts -> src/modules/orders/service.ts

Why this matters:
The reverse dependency creates a cycle that was absent at session start.

Suggested actions:
1. Remove or invert the new reverse dependency.

[Codex repairs the dependency]

BRAID LIVE GUARD — PASS
No new architecture regressions.
```

Feedback is capped by `maxFindings` and `maxFeedbackCharacters`. It contains relative paths, relevant
edges or symbols, baseline/current evidence, the practical consequence, and no more than two bounded
suggestions per finding.

## Fail-open behavior and trust boundary

The adapter accepts one bounded validated JSON payload on stdin, writes exactly
one host JSON response on stdout, and sends diagnostics to stderr. It invokes
one foreground Braid CLI process without a shell, network, detached process,
or background work. A malformed payload, missing/incompatible CLI, missing
repository, timeout, nonzero exit, malformed output, or analyzer failure fails
open under the verified host contract and never fabricates an architectural
`pass` report.

The repository owner, Braid configuration, Codex executable, Git, Node.js, operating system, and
filesystem are trusted. Growth Mode is architecture feedback and a completion guard, not an OS or
adversarial-repository security boundary.

## Known limitations

- Only statically analyzed TypeScript/TSX/MTS/CTS source and supported imports are covered.
- A full deterministic scan runs after a relevant change; Growth Mode v1 is not an incremental compiler.
- A staged blob that differs from its working-tree file invalidates the cache, but v1 analyzes the
  current working-tree file rather than constructing a separate index-only source tree.
- Tool-event coverage follows each installed host implementation and is not universal; the final scan is authoritative.
- Copilot is local CLI only and 1.0.71 has no working plugin enable/disable command.
- Codex 0.144.5 has no plugin enable/disable CLI subcommand; use its native inspection UI or uninstall.
- Gemini extension changes require a new CLI session.
- Claude Code is unavailable until its authenticated Stop-hook gate closes.
- Warnings and blockers are limited to configured v1 rules; no general boundary policy is inferred.
- Unresolved or ambiguous static evidence warns instead of proving a hard violation.
- Wall-clock measurements are informational and are not CI blockers.
- Hook installation is repository-local and still requires explicit Codex trust review.
