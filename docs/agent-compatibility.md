# Agent platform compatibility research

Research date: 2026-07-17 (Asia/Taipei)
Host: Darwin 27.0, arm64

This document records the Braid v0.6.0 official-contract gate and the native
adapter implementation boundary. A platform is not eligible for production
Growth Mode until official documentation and an isolated live CLI probe both
prove final-stop blocking, an additional agent turn, and repair-to-pass.
Executable discovery or schema parsing alone is insufficient. The authorized
production adapters are Codex, Claude Code 2.1.215, Gemini CLI, and local
Copilot CLI. Claude web and cloud-agent environments are not included.

## Gate result

| Platform              | Tested CLI | Contract   | Live final-stop                         | Research classification     | v0.6 production status |
| --------------------- | ---------- | ---------- | --------------------------------------- | --------------------------- | ---------------------- |
| OpenAI Codex          | 0.144.5    | documented | block → additional turn → pass          | `verified`                  | supported              |
| Anthropic Claude Code | 2.1.215    | documented | block → additional turn → repair → pass | `verified`                  | supported              |
| Google Gemini CLI     | 0.40.0     | documented | block → additional turn → pass          | `verified`                  | supported              |
| GitHub Copilot CLI    | 1.0.71     | documented | block → additional turn → repair → pass | `verified-with-limitations` | supported              |

**Status: verified for exact local version 2.1.215 on Darwin arm64.**

Production scope does not infer support for later CLI versions, Claude web, or Claude
cloud agents. The earlier unauthenticated 2.1.212 attempt remains historical
context; the later authenticated gate supersedes its production conclusion.

## Preflight

No account names, credentials, tokens, prompt text, transcripts, session
databases, or unredacted home paths were retained.

| Field                    | Claude Code                                                                                                     | GitHub Copilot CLI                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable               | `/Users/<user>/.local/bin/claude` → native version directory                                                    | `/opt/homebrew/bin/copilot` → Homebrew Cask directory                                                                                                    |
| Exact version            | `2.1.212 (Claude Code)`, commit `8b2783a8f907`                                                                  | `GitHub Copilot CLI 1.0.71`                                                                                                                              |
| Installation channel     | native installer, `latest` update channel                                                                       | Homebrew Cask                                                                                                                                            |
| Doctor/version result    | native install healthy; `darwin-arm64`                                                                          | version command succeeded and reported current                                                                                                           |
| Authentication readiness | not ready: `loggedIn:false`, `authMethod:none`; no API-key, Bedrock, Vertex, or Foundry provider was configured | ready: `/user show` confirmed an authenticated account without retaining its identifier, and a no-tool model request returned exactly `READY`            |
| Relevant help reviewed   | `--setting-sources`, `--settings`, `--resume`, `--continue`, `--worktree`, `-p`, hook event filtering           | `COPILOT_HOME`, `--resume`, `--continue`, `-p`, `-i`, scoped allow/deny tool flags, `--no-remote`, `--no-remote-export`, `--no-auto-update`, `--log-dir` |
| Unsafe options used      | none                                                                                                            | none                                                                                                                                                     |

`claude doctor`, `claude --help`, `copilot --help`, `copilot help`, and
`copilot help config` were reviewed. No login command, broad permission flag,
user-level hook, cloud job, or authentication-setting change was used by the
research harness.

`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` were all absent from the
probe environment; no token value was read or printed.

## Required four-platform matrix

Codex and Gemini rows carry forward the earlier isolated contract probes
recorded by this document. This task re-ran only the Claude and Copilot gates.

| Field                      | Codex                                                                  | Claude Code                                                | Gemini CLI                                     | Copilot CLI                                                              |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| CLI version tested         | 0.144.5                                                                | 2.1.215                                                    | 0.40.0                                         | 1.0.71                                                                   |
| Official source            | yes                                                                    | yes                                                        | yes                                            | yes                                                                      |
| Executable and help probe  | yes                                                                    | yes                                                        | yes                                            | yes                                                                      |
| Local live hook probe      | yes                                                                    | yes; authenticated native package                          | yes                                            | yes                                                                      |
| Config path                | `.codex/hooks.json`                                                    | `.claude/settings.local.json`                              | `.gemini/settings.json`                        | `.github/copilot/settings.local.json`                                    |
| Local-only path            | no                                                                     | yes                                                        | no                                             | yes                                                                      |
| Session event              | `SessionStart`                                                         | `SessionStart`                                             | `SessionStart`                                 | `sessionStart`                                                           |
| Prompt event               | `UserPromptSubmit`                                                     | `UserPromptSubmit`                                         | `BeforeAgent`                                  | `userPromptSubmitted`                                                    |
| Mutation event             | `PostToolUse`                                                          | `PostToolUse`                                              | `AfterTool`                                    | `postToolUse`                                                            |
| Final-stop event           | `Stop`                                                                 | `Stop`                                                     | `AfterAgent`                                   | `agentStop`                                                              |
| Final-stop blocking proven | yes                                                                    | yes                                                        | yes                                            | yes                                                                      |
| Additional turn proven     | yes                                                                    | yes                                                        | yes                                            | yes                                                                      |
| Repair-to-pass proven      | yes                                                                    | yes                                                        | yes                                            | yes                                                                      |
| Worktree tested            | yes; native adapter deterministic lifecycle                            | yes; live package and deterministic lifecycle              | yes; native adapter deterministic lifecycle    | yes; live contract and native adapter deterministic lifecycle            |
| Ownership strategy         | documented                                                             | documented below                                           | documented                                     | documented below                                                         |
| Known limitations          | shell mutation interception is incomplete; final scan is authoritative | exact local 2.1.215 Darwin arm64 scope; no web/cloud claim | trust and cumulative retry output require care | timeout leaves child processes alive; continuation re-fires prompt event |
| Final classification       | `verified`                                                             | `verified`                                                 | `verified`                                     | `verified-with-limitations`                                              |

No minimum supported version is inferred merely from the installed version.

### Native v0.6 package paths

The research config paths above remain the native inline/manual contracts. The
preferred v0.6 installation does not edit those files; it uses vendor plugin
or extension packaging:

| Platform    | Marketplace or extension discovery | Adapter manifest                                  | Local-only               |
| ----------- | ---------------------------------- | ------------------------------------------------- | ------------------------ |
| Codex       | `.agents/plugins/marketplace.json` | `plugins/braid/.codex-plugin/plugin.json`         | no                       |
| Claude Code | `.claude-plugin/marketplace.json`  | `plugins/braid-claude/.claude-plugin/plugin.json` | no                       |
| Gemini CLI  | `gemini-extension.json`            | `gemini-extension.json` plus `hooks/hooks.json`   | no                       |
| Copilot CLI | `.github/plugin/marketplace.json`  | `plugins/braid/plugin.json`                       | no; local CLI scope only |

All four local packages passed isolated discovery, install, list, setup,
uninstall, and reinstall. Their common adapter also passed normal-checkout and
linked-worktree baseline, block, bounded retry, repair, and pass tests against
the real Braid Growth engine. Claude additionally passed the authenticated
package lifecycle without changing global plugin configuration; no auth or
user configuration was copied into an isolated home.

## Anthropic Claude Code

Official sources: [hooks reference](https://code.claude.com/docs/en/hooks),
[settings](https://code.claude.com/docs/en/settings),
[configuration diagnostics](https://code.claude.com/docs/en/debug-your-config),
[CLI reference](https://code.claude.com/docs/en/cli-reference), and
[worktrees](https://code.claude.com/docs/en/worktrees).

### Official contract

- Project hooks may be stored in `.claude/settings.json` (committable) or
  `.claude/settings.local.json` (single-project and local-only). Braid should
  use the latter.
- `/hooks` is the native read-only inspection surface. It labels
  `.claude/settings.local.json` handlers as `Local` and displays their source
  file. Direct settings edits are normally picked up by the file watcher.
- Project hooks require workspace trust and may be disabled by managed hook
  policy. Braid must inspect and report these states, never grant trust or
  change policy.
- Command hooks receive one JSON object on stdin. Common fields include
  `session_id`, `transcript_path`, `cwd`, `permission_mode`, and
  `hook_event_name`. Braid must ignore and never persist prompts, transcript
  paths, assistant text, tool results, and source content.

| Braid lifecycle | Native event       | Additional native stdin                                                  | Exit-0 stdout used by Braid                                               |
| --------------- | ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `session-start` | `SessionStart`     | `source: startup\|resume\|clear\|compact`; optional model/agent metadata | `hookSpecificOutput.additionalContext` or empty output                    |
| `prompt-submit` | `UserPromptSubmit` | `prompt`                                                                 | `hookSpecificOutput.additionalContext` or empty output                    |
| `post-mutation` | `PostToolUse`      | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`                | `hookSpecificOutput.additionalContext`; it cannot undo the completed tool |
| `final-stop`    | `Stop`             | `stop_hook_active`, `last_assistant_message`, plus additive task fields  | pass: `{}` or empty; block: `{"decision":"block","reason":"..."}`         |

For `Stop`, `decision: "block"` prevents stopping and causes the agent session
to continue with an additional turn using `reason`. The continued Stop input
sets `stop_hook_active: true`. Current official documentation also caps eight
consecutive Stop continuations, but Braid must retain its smaller
fingerprint-based finite policy. Exit 2 plus stderr also blocks Stop; other
nonzero exits are fail-open for most events.

Command-hook timeout defaults to 600 seconds, except `UserPromptSubmit`, whose
default is 30 seconds. The official reference does not establish the tested
2.1.212 Stop outcome for malformed stdout or command timeout strongly enough
to replace a live probe; those two final-stop cases remain unknown. Unknown
additive settings/output fields are likewise not a production guarantee, so a
Braid editor must preserve them without depending on them.

On resume, `SessionStart` fires again with `source: "resume"`; previously
injected mid-session context is replayed rather than re-running historical
hooks. Worktree use remains subject to project trust. These documented claims
were not promoted to live evidence.

### Live probe result

The later authenticated gate used Claude Code 2.1.215, an isolated repository,
the native development plugin surface, and redacted lifecycle evidence. It
proved `SessionStart -> UserPromptSubmit -> Stop(block) -> repair ->
Stop(allow)` in the same session. The first Stop had
`stop_hook_active: false`; the repaired Stop had `true`. Separate evidence
proved early `PostToolUse` detection, shell-mutation fallback to the final
scan, duplicate native/manual suppression, and linked-worktree state
isolation.

The field-shape probe found that 2.1.215 `SessionStart` omits
`permission_mode`, while turn events include it. The production schema keeps
these fields separate. Prompts, tool input/output, transcript paths, account
data, authentication material, and raw session identifiers were not retained.

During verification the active binary advanced first to 2.1.216 and later to
2.1.217. The retained 2.1.215 executable completed the exact-version tests;
Braid rejected both newer versions and returned the empty Claude fail-open
response. No adjacent-version range is inferred.

Research classification: `verified` for local Claude Code 2.1.215 on Darwin
arm64. Claude web, cloud agents, and other CLI versions remain unavailable.

## GitHub Copilot CLI

Official sources reviewed again on 2026-07-17:
[Authenticating GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli),
[Administering Copilot CLI for your enterprise](https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise),
[hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
[CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[using hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks),
and the [official changelog](https://github.com/github/copilot-cli/blob/main/changelog.md).

### Official contract and CLI-only scope

Copilot CLI reads repository inline hooks from both
`.github/copilot/settings.json` and `.github/copilot/settings.local.json`; the
local file uses the same repository schema, takes precedence, and should be
gitignored. The cloud coding agent's documented default discovery loads only
`.github/hooks/*.json` from the cloned repository. Therefore Braid's proposed
path is `.github/copilot/settings.local.json`, and the earlier
`.github/hooks/braid.json` proposal is rejected.

The documented settings precedence is built-in → managed policy → user
settings → `.github/copilot/settings.json` →
`.github/copilot/settings.local.json` → environment → CLI flags. Hook entries
from applicable sources are combined, so Braid must not depend on a particular
cross-source execution order. The current native inspection surface is `/env`;
the command reference does not document a Copilot CLI `/hooks` command.

Cloud-scope decision: `cli-only-scope-verified`, based on the earlier live
`/env` source observation and the re-reviewed current official discovery
contract. This means only that the configuration path is outside cloud default
discovery; no cloud-agent compatibility is claimed.

| Braid lifecycle | Native event          | Native stdin                                                                                          | Exit-0 stdout used by Braid                                                        |
| --------------- | --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `session-start` | `sessionStart`        | `sessionId`, millisecond `timestamp`, `cwd`, `source: startup\|resume\|new`, optional `initialPrompt` | `{"additionalContext":"..."}` or `{}`                                              |
| `prompt-submit` | `userPromptSubmitted` | `sessionId`, `timestamp`, `cwd`, `prompt`                                                             | `{}`; do not rely on prompt output                                                 |
| `post-mutation` | `postToolUse`         | `sessionId`, `timestamp`, `cwd`, `toolName`, `toolArgs`, successful `toolResult`                      | `additionalContext` or `modifiedResult`; Braid uses context only                   |
| `final-stop`    | `agentStop`           | `sessionId`, `timestamp`, `cwd`, `transcriptPath`, `stopReason: end_turn`                             | pass: `{"decision":"allow"}` or `{}`; block: `{"decision":"block","reason":"..."}` |

`agentStop` block causes the agent session to continue with an additional turn
using `reason`. The payload documents no continuation indicator or native
retry count, so Braid-owned fingerprint/count state is mandatory.

The current hooks reference says `userPromptSubmitted` output is not processed,
while the official 1.0.65 changelog says its `additionalContext` was added to
the model-facing prompt. The 1.0.71 live probe observed that context in the
model response, but the normative conflict remains; Braid may use the command
event only for deterministic internal state and must emit `{}`.

For command hooks, exit 0 parses stdout as one JSON value. Exit 2 is a warning
and fail-open for `agentStop`; other nonzero exits are also fail-open. The
default `timeoutSec` is 30 seconds and timeout is fail-open. After progress
lines are removed, malformed or multiple stdout objects fail JSON parsing and
are treated as no output. Repository-level unknown settings keys are silently
ignored; Braid must still preserve them because later native writes may remove
unknown fields.

The current configuration-directory reference explicitly supports JSONC for
user settings. It says repository-local settings use the repository schema but
does not separately guarantee comment/trailing-comma grammar or lossless
rewrites for `.github/copilot/settings.local.json`. Production ownership must
therefore use path-level comment-preserving edits if live evidence confirms
JSONC, or refuse such input; plain `JSON.parse` plus full-file stringify is not
a safe recommendation.

Prompt-type hooks fire only for new interactive sessions, not resume or `-p`,
and are excluded from the Braid design. Non-interactive `-p` repository hooks
are a separate contract: they are not loaded by default unless repository
trust and the documented prompt-mode repository-hook opt-in are present. No
non-interactive or cloud compatibility is claimed by this gate.

### Live probe result after login

The fresh readiness gate used an isolated temporary `COPILOT_HOME`, disabled
remote control/export, automatic update, built-in MCPs, and custom instructions,
and accepted folder trust for that session only. `/user show` confirmed an
authenticated account, but its identifier was suppressed before inspection.
The three GitHub token environment variables named above were absent. A minimal
session with no model tools returned exactly `READY`, so runtime readiness is
now `ready`.

The earlier policy-denied result is retained only as historical evidence:

> You are not authorized to use this Copilot feature, it requires an
> enterprise or organization policy to be enabled.

No request ID or account identity was retained from either run.

The lifecycle probe used inline command hooks from
`.github/copilot/settings.local.json` in a disposable Git repository. `/env`
displayed all four events with source `repo settings`. The live results were:

- `sessionStart` fired with `source: new`; `--continue` produced a second
  `sessionStart` with `source: resume`.
- `userPromptSubmitted` fired for the user's prompt. Each `agentStop` block
  continuation also emitted another `userPromptSubmitted`, so it is not a
  once-per-human-input signal in this continuation path.
- `postToolUse` reported runtime tool `apply_patch` after both a direct file
  creation and a later file edit. A shell mutation reported runtime tool
  `bash`; all three mutations reached the expected disposable file state.
- The first `agentStop` returned `decision: "block"` for a deterministic
  architecture regression. Copilot continued the same agent session with an
  additional turn, repaired the file, then invoked `agentStop` again; the
  passing `decision: "allow"` completed the turn.
- A separate unchanged-block probe produced `block → block → allow`. The final
  allow came from the Braid-style count bound, proving repeated blocking can be
  finite without relying on an undocumented native retry limit.
- A `userPromptSubmitted` command hook returning `additionalContext` affected
  the model response in 1.0.71. This conflicts with the current event table's
  “Output processed: No” entry, so Braid must still emit `{}` and not depend on
  that output.

Malformed `agentStop` stdout, an intentional exit 3, and a two-second timeout
all failed open: the model response remained visible, the turn stopped, and no
additional continuation occurred. The timeout warning was visible. The timeout
killed the hook parent but not its child: the child wrote a marker four seconds
later and then exited. Production Braid command hooks must therefore remain a
single process and must not rely on Copilot to clean up descendants.

Normal checkout lifecycle succeeded. A new orphan linked worktree did not
inherit the untracked local settings file; after a separate worktree-local
install, `sessionStart`, `userPromptSubmitted`, and passing `agentStop` all
fired. This confirms the ownership recommendation must install and inspect each
worktree separately.

No `.github/hooks/*.json`, user-level hook, authentication setting, GitHub
credential, cloud job, Braid production source, or tracked file other than this
compatibility document was modified. Disposable sessions, logs, prompts,
session databases, probe source, and absolute paths were removed after sanitized
evidence was extracted.
Every probe process used an isolated `COPILOT_HOME`. The real user-config hash
no longer matched the earlier research run's baseline at final audit; because
this run did not take a fresh pre-probe hash, it makes no byte-for-byte
unchanged claim and does not attribute that pre-existing difference.
Non-interactive `-p` and cloud-agent compatibility remain outside this live
classification.

Growth classification: `verified-with-limitations`. The final-stop production
gate itself is closed; the limitations are addressed by Braid-owned finite
retry state, an authoritative final scan, empty prompt-hook output, and a
single-process command hook.

## Carried-forward Codex and Gemini evidence

### OpenAI Codex

Official sources: [hooks](https://learn.chatgpt.com/docs/hooks) and
[advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced).

Repository configuration remains `.codex/hooks.json`. The isolated 0.144.5
probe observed `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and `Stop`.
The first Stop returned `decision: "block"`; Codex produced an additional
agent turn and a second Stop with `stop_hook_active: true`; the subsequent pass
completed. Shell mutation coverage is incomplete upstream, so the final
working-tree scan remains authoritative. Classification: `verified`.

Ownership remains structural and bounded: preserve unknown keys and unrelated
`.codex/hooks.json` groups, identify only the existing fixed Braid command and
status marker, back up and atomically write, make repeated install idempotent,
and remove only exact owned handlers without changing Codex trust.

### Google Gemini CLI

Official sources: [v0.40.0 hooks reference](https://github.com/google-gemini/gemini-cli/blob/v0.40.0/docs/hooks/reference.md),
[configuration](https://github.com/google-gemini/gemini-cli/blob/v0.40.0/docs/reference/configuration.md),
and [trusted folders](https://github.com/google-gemini/gemini-cli/blob/v0.40.0/docs/cli/trusted-folders.md).

Repository configuration remains `.gemini/settings.json`. The isolated 0.40.0
probe observed `SessionStart`, `BeforeAgent`, `AfterTool`, and `AfterAgent`.
An `AfterAgent` deny caused an additional agent turn; the next pass completed.
Project hooks require folder trust, and the final scan remains authoritative
for shell mutations. Classification: `verified`.

Ownership remains structural and bounded: preserve unknown keys and unrelated
`.gemini/settings.json` hooks, use one fixed Braid `name` per native event,
back up and atomically write, make repeated install idempotent, and remove only
exact owned entries without changing folder trust.

## Contract fixtures

Claude and Copilot fixtures preserve sanitized live field shapes. Synthetic
Codex and Gemini fixtures remain labeled as official-contract test shapes; none
is represented as live evidence.

| Platform            | Required live fixtures                                                                           | Captured | Result                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| Claude Code 2.1.215 | `SessionStart`, `UserPromptSubmit`, Edit `PostToolUse`, Stop pass/block/repeated                 | 4        | sanitized authenticated field shapes plus redacted outcome log     |
| Copilot CLI 1.0.71  | `sessionStart`, `userPromptSubmitted`, file/shell `postToolUse`, `agentStop` pass/block/repeated | 8        | required seven shapes plus a separate resumed `sessionStart` shape |

The sanitized Claude and Copilot fixture sets record platform, exact CLI version, capture
date, official event name, and redaction note. Prompts, continuation reasons,
session IDs, account identifiers, home and transcript paths, source content,
tool arguments, and tool results were replaced while genuinely observed
additive payload keys were retained. Private disposable probe material was not
committed.

## Ownership recommendation

The v0.6 native path owns only committed marketplace/manifest assets and each
host's normal plugin installation record. It never edits user-global settings,
trust, authentication, or the earlier project-local inline hook files.

| Platform    | Exact committed path                                                                | Install ownership                                | Bounded uninstall                                                                        |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Codex       | `.agents/plugins/marketplace.json`, `plugins/braid/**`                              | Codex plugin cache and normal enabled record     | `codex plugin remove braid@braid`; local CLI has no enable/disable subcommand in 0.144.5 |
| Gemini CLI  | `gemini-extension.json`, `hooks/hooks.json`, `commands/braid/**`, canonical runtime | Gemini extension store under its configured home | `gemini extensions disable/enable/uninstall braid`; restart after changes                |
| Copilot CLI | `.github/plugin/marketplace.json`, `plugins/braid/**`                               | local Copilot CLI installed-plugin store         | `copilot plugin uninstall braid@braid`; 1.0.71 has no working enable/disable command     |

All manifests use fixed `braid` identifiers and version `0.6.0`. Repeated
install/uninstall/reinstall is host-owned and passed in isolated homes. Remote
GitHub update behavior remains a post-push smoke. The shared runtime is copied
by a deterministic repository script and drift is a validation failure. A
missing or incompatible Braid CLI causes the adapter to fail open with
diagnostics on stderr.

The following table remains the structural merge recommendation only for the
unimplemented Claude adapter and the researched Copilot inline fallback:

| Platform    | Exact path                            | Commit status                                        | Braid entry identity                                                                                                                 |
| ----------- | ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `.claude/settings.local.json`         | local-only; refuse install if tracked or not ignored | event + supported `type`, `command`, `args`, timeout, and a fixed Braid `statusMessage`; do not add unsupported owner fields         |
| Copilot CLI | `.github/copilot/settings.local.json` | local-only; refuse install if tracked or not ignored | event + supported `type`, command, timeout, and `env` values `BRAID_GROWTH_HOOK_OWNER`/`BRAID_GROWTH_HOOK_ID`; no unknown `id` field |

For Copilot, the official command-entry fields are `type`, one of
`command`/`bash`/`powershell`, optional `cwd`, `env`, and
`timeoutSec`/`timeout`; some tool events also accept `matcher`. There is no
official `id`, `name`, or `statusMessage`. Stable Braid identity therefore
belongs in supported `env` keys: fixed owner, per-event ID, ownership schema,
and a SHA-256 self-fingerprint. Preserve `disableAllHooks: true` and report
`installed-disabled`; never flip user policy. Hook configuration changes
require a new Copilot session rather than assuming hot reload.

Use the existing Codex installer pattern rather than a new configuration
framework:

1. Resolve the current Git worktree root; reject a config symlink or resolved
   path outside it. Each worktree owns its own ignored local settings file.
2. Parse with a comment-preserving JSONC editor and validate only the
   containers Braid touches. Malformed input or ambiguous duplicate touched
   keys is a no-write error. Preserve comments, trailing commas, unknown keys,
   ordering, and every unrelated setting and hook.
3. Structurally merge one exact Braid command entry per required event.
   Repeated install is idempotent. Exact Braid-owned duplicates may normalize
   to one; lookalikes or conflicting owner signatures are an explicit
   ownership conflict.
4. `--dry-run` returns the capability result and semantic change without
   writing. Status distinguishes missing CLI, unsupported/unready CLI,
   malformed config, conflict, partial install, and ready.
5. Before changing an existing file, write one adjacent content-hash backup.
   Write a same-directory temporary file, reparse it, atomically rename it,
   then verify unrelated entries and exactly one Braid set remain.
6. Record only exact owned entries and fingerprints in the existing proposed
   `.braid/adapters/<platform>.json` manifest shape. Bounded uninstall removes
   only fingerprint-matching Braid entries and prunes only empty containers
   Braid created; it remains available even when the agent CLI is missing.
7. Commands and paths must be repository-relative (`${CLAUDE_PROJECT_DIR}` for
   Claude where applicable) so repository relocation does not embed a home
   path. Status reports a missing Braid launcher or platform CLI; hooks fail
   open visibly and never loop, modify source, write Git state, or use network.

No global settings, trust records, authentication state, `.github/hooks/*.json`,
or unrelated native settings are owned by Braid.

## Recommended v0.6.0 matrix

This is the exact evidence-backed production matrix now. Claude is deliberately
exact-version scoped; Copilot Growth remains subject to the documented
single-process and bounded-retry constraints.

| Platform    | Detection | Growth Mode                                     | Migration   |
| ----------- | --------- | ----------------------------------------------- | ----------- |
| Codex       | Stable    | Stable                                          | Stable      |
| Claude Code | Stable    | Stable for local 2.1.215 on Darwin arm64        | Unavailable |
| Gemini CLI  | Stable    | Stable                                          | Unavailable |
| Copilot CLI | Stable    | Stable for local CLI; verified-with-limitations | Unavailable |

Remote Claude installation from Arthur's feature branch passed. The upstream
owner/repository path remains a post-merge smoke.

## Native adapter implementation boundary

- `packages/guard` owns the host-neutral lifecycle bridge and the Codex,
  Claude, Gemini, and Copilot stdin/stdout translations. It delegates all architecture
  analysis, baseline, classification, final policy, and bounded retry state to
  the existing `GrowthGuardLifecycle`.
- `apps/cli` owns `growth setup --host`, host-aware `growth status`, and the
  hidden native hook entrypoint. The existing manual Codex installer and the
  ownership-safe Claude manual fallback remain separate from migration execution.
- `adapters/native-agent/runtime.mjs` is the standard-library-only launcher.
  The Codex/Copilot package and dedicated Claude package contain synchronized
  physical copies; Gemini uses the canonical file from its extension root.
- Host packages own only event names, payload/output mapping, four user
  commands, and plugin metadata. They do not install Braid, enable Growth Mode,
  edit project settings, make architecture decisions, or claim cloud-agent
  support.

Required post-merge work is limited to the upstream owner/repository install
smoke and expanding the exact-version gate only after another authenticated
lifecycle proof.
