# Native agent plugins for Braid v0.6.0

Research and implementation date: 2026-07-18 (Asia/Taipei)
Host: Darwin 27, arm64

This is the production contract gate and implementation note for the first
native Braid Growth Mode adapters. It covers Codex, Claude Code, Gemini CLI,
and local GitHub Copilot CLI. Claude support is exact-version scoped to the
authenticated local 2.1.215 contract tested on Darwin arm64.

The adapters are packaging and protocol translators around the existing
`braid growth` engine. They do not analyze architecture, create baselines,
classify findings, choose retry limits, execute migrations, or mutate source
or Git state.

## Evidence labels

- **Live**: observed with the exact installed CLI in an isolated repository.
- **Official**: specified by the vendor documentation or the installed
  vendor implementation.
- **Verified local package**: observed through an isolated install/list or
  lifecycle smoke using the packaged adapter in this branch.
- **Post-push**: cannot be proved until this branch is available from GitHub.

## Tested hosts

| Host               | Exact version       | Installation surface                      | Growth contract             |
| ------------------ | ------------------- | ----------------------------------------- | --------------------------- |
| Codex              | `codex-cli 0.144.5` | native marketplace plugin                 | `verified`                  |
| Claude Code        | `2.1.215`           | native marketplace plugin                 | `verified`                  |
| Gemini CLI         | `0.40.0`            | native extension                          | `verified`                  |
| GitHub Copilot CLI | `1.0.71`            | native marketplace plugin, local CLI only | `verified-with-limitations` |

No minimum version older than these tested versions is inferred.

## Codex 0.144.5

### Official package contract

- Marketplace discovery: `.agents/plugins/marketplace.json`; the desktop app
  also accepts the legacy-compatible `.claude-plugin/marketplace.json`.
- Dedicated Braid plugin root: `plugins/braid/`.
- Required manifest: `plugins/braid/.codex-plugin/plugin.json`.
- Hook configuration: a manifest `hooks` path or the default
  `hooks/hooks.json`, resolved within the plugin root.
- Runtime variables: `PLUGIN_ROOT` and writable `PLUGIN_DATA`; Codex also sets
  the Claude-compatible aliases.
- Installed cache: `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`.
- Lifecycle: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`.
- Inspection and trust: `/hooks`; new or changed command hooks do not run
  until reviewed and trusted.
- Plugin skills are invoked through Codex skill namespacing. Braid exposes
  `$braid:setup`, `$braid:status`, `$braid:check`, and `$braid:help`; Codex
  does not provide plugin-defined slash commands with the requested syntax.

Installed command surface:

```text
codex plugin marketplace add <local-path-or-owner/repo>
codex plugin marketplace list
codex plugin marketplace upgrade [marketplace]
codex plugin marketplace remove <marketplace>
codex plugin add braid@braid
codex plugin list --json
codex plugin remove braid@braid
```

Codex 0.144.5 has no CLI `plugin enable`, `plugin disable`, or per-plugin
`plugin update` command. The desktop plugin UI can enable or disable a plugin;
the CLI can disable individual non-managed hooks through `/hooks`. Marketplace
refresh uses `plugin marketplace upgrade`. A new CLI session is required for
fresh hook discovery; the desktop app must be restarted after marketplace or
plugin changes.

Local development was verified with an isolated `CODEX_HOME` using:

```text
codex plugin marketplace add <worktree>
codex plugin add braid@braid
```

Discovery, install, list, remove, reinstall, and marketplace removal passed.
Codex 0.144.5 refuses to upgrade a local marketplace; a Git-backed marketplace
upgrade still requires the post-push smoke. The intended remote commands are:

```text
codex plugin marketplace add ting10688/Braid
codex plugin add braid@braid
```

The owner/repository form is valid only after this content exists on the
repository's default branch and must pass the post-merge smoke before it is
reported as verified.

### Live lifecycle contract carried forward

The 0.144.5 research probe observed all four events. A blocking `Stop`
continued the same agent session with an additional turn; the next `Stop`
included `stop_hook_active: true` and passed. Shell mutation interception is
not complete, so Braid's final working-tree scan remains authoritative.

The existing manual repository adapter remains supported:

```text
braid growth install codex --confirm
```

The native plugin is preferred in v0.6.0. A native invocation must detect an
installed manual adapter, fail open for the duplicate invocation, and print
the exact remediation `braid growth uninstall codex` to stderr.

## Claude Code 2.1.215

Claude discovers `.claude-plugin/marketplace.json`, the dedicated
`plugins/braid-claude/.claude-plugin/plugin.json`, the standard
`plugins/braid-claude/hooks/hooks.json`, and four Markdown commands. Because Claude
auto-loads the standard hook path, the plugin manifest deliberately does not
declare it again. The validator rejects that duplicate-registration shape.

Install from the repository marketplace after installing the Braid CLI:

```text
/plugin marketplace add ting10688/Braid
/plugin install braid@braid
/braid:setup
```

The equivalent CLI supports marketplace add/remove, plugin install/uninstall,
list/details, enable/disable, and update. Run `/reload-plugins` or start a new
session after hook changes. The plugin invokes the shared bounded runtime with
`${CLAUDE_PLUGIN_ROOT}` and never downloads Braid, initializes a project, or
enables Growth Mode.

The authenticated package lifecycle proved:

```text
SessionStart(context)
UserPromptSubmit(allow)
Stop(block, stop_hook_active=false)
PostToolUse(Edit, allow)
Stop(allow, stop_hook_active=true)
```

An earlier file-tool mutation also proved early `PostToolUse` detection. A
separate shell mutation bypassed that matcher and proved the final Stop scan is
authoritative. The repaired worktree returned clean. Normal and linked
worktrees completed the same block/repair/pass lifecycle.

The live payload contract has one important asymmetry: `SessionStart` omits
`permission_mode`, while turn events include it. The adapter keeps separate
schemas and strips prompts, tool input/output, transcript paths, model output,
and raw session identifiers before dispatch. Claude 2.1.216 and 2.1.217 are
rejected and return `{}` fail-open; no adjacent-version compatibility is
inferred.

When marketplace installation is unavailable, the explicit fallback is:

```text
braid growth install claude --dry-run
braid growth install claude --confirm
```

It merges only Braid-owned handlers into `.claude/settings.local.json`, uses
atomic writes and content-addressed backups, preserves unrelated settings, and
resolves linked worktrees through the main checkout. Native is authoritative
if both adapters exist; remove the fallback with
`braid growth uninstall claude`.

## GitHub Copilot CLI 1.0.71

### Official package contract

- Marketplace discovery: `.github/plugin/marketplace.json` (preferred);
  `.claude-plugin/marketplace.json` is also recognized.
- Dedicated Braid plugin root: `plugins/braid/`.
- Manifest search includes root `plugin.json`; Braid uses
  `plugins/braid/plugin.json`.
- Hook configuration: manifest `hooks` path or `hooks.json` /
  `hooks/hooks.json` under the plugin root.
- Runtime variables: `PLUGIN_ROOT` and writable `COPILOT_PLUGIN_DATA`.
- Installed path: `~/.copilot/installed-plugins/<marketplace>/<plugin>/`, or
  `_direct/<source-id>/` for direct installs. `COPILOT_HOME` and
  `COPILOT_CACHE_HOME` provide isolated test roots.
- Lifecycle: `sessionStart`, `userPromptSubmitted`, `postToolUse`, `agentStop`.
- Inspection: `/env` identifies plugin and hook sources.
- Plugin command files are namespaced by the plugin. Braid exposes
  `/braid:setup`, `/braid:status`, `/braid:check`, and `/braid:help`.

Installed command surface:

```text
copilot plugin marketplace add <local-path-or-owner/repo>
copilot plugin marketplace list
copilot plugin marketplace browse <marketplace>
copilot plugin marketplace update [marketplace]
copilot plugin marketplace remove <marketplace>
copilot plugin install braid@braid
copilot plugin list
copilot plugin update braid@braid
copilot plugin uninstall braid@braid
```

Current GitHub documentation lists plugin enable/disable commands, but the
installed 1.0.71 `copilot plugin --help` omits them. Its broader
`copilot plugins` help advertises enable/disable, but executing those
subcommands returns `The plugins command is not available.` This version can
therefore update or uninstall but cannot be claimed to support CLI
enable/disable. A new session is required after hook changes.

Local development was verified with isolated `COPILOT_HOME` and
`COPILOT_CACHE_HOME` using:

```text
copilot plugin marketplace add <worktree>
copilot plugin install braid@braid
```

Discovery, install, list, local update, uninstall, reinstall, and marketplace
removal passed without login or token changes. The intended remote commands are:

```text
copilot plugin marketplace add ting10688/Braid
copilot plugin install braid@braid
```

The installed package contains the four namespaced command definitions. The
owner/repository form is valid only after this content exists on the default
branch and remains pending a post-merge smoke.

### Live lifecycle contract carried forward

The authenticated 1.0.71 probe observed new and resumed `sessionStart`,
`userPromptSubmitted`, file and shell `postToolUse`, and `agentStop`.
`agentStop` block caused an additional turn, repair, and a passing stop.
`block -> block -> allow` proved finite repeated blocking under Braid-owned
state.

Production constraints from that live probe:

- emit `{}` for `userPromptSubmitted`; do not depend on its stdout;
- do not depend on cross-source hook ordering;
- malformed stdout, nonzero exit, and timeout fail open;
- the host timeout does not clean up hook descendants, so the adapter awaits
  one foreground Braid process and must terminate it on its own timeout;
- a linked worktree needs its own repository state but uses the installed
  plugin; the final scan, not tool names, is authoritative;
- no Copilot cloud-agent compatibility is claimed.

## Gemini CLI 0.40.0

### Official package contract

- Remote installation requires `gemini-extension.json` at the repository
  root, so Braid's Gemini extension root is the Braid repository root.
- Required manifest: `gemini-extension.json`.
- Hook configuration: `hooks/hooks.json`; hooks are not declared in the
  manifest.
- Commands: `commands/braid/setup.toml`, `status.toml`, `check.toml`, and
  `help.toml`, exposed as `/braid:setup`, `/braid:status`,
  `/braid:check`, and `/braid:help`.
- Runtime variables in manifest and hooks: `${extensionPath}`,
  `${workspacePath}`, and `${/}`.
- Installed path: `${GEMINI_CLI_HOME:-$HOME}/.gemini/extensions/<name>/`.
- Lifecycle: `SessionStart`, `BeforeAgent`, `AfterTool`, `AfterAgent`.
- Inspection: `/hooks` and `/extensions list`.

Installed command surface:

```text
gemini extensions validate <extension-path>
gemini extensions install <local-path-or-github-url>
gemini extensions link <local-path>
gemini extensions list --output-format json
gemini extensions update [braid]
gemini extensions disable braid [--scope workspace]
gemini extensions enable braid [--scope workspace]
gemini extensions uninstall braid
```

Extension management and updated slash commands take effect after restarting
Gemini CLI. The local extension passed `extensions validate`, install, list,
disable, enable, uninstall, and reinstall under an isolated `GEMINI_CLI_HOME`.
Gemini 0.40.0 writes no list output when stdout is not a TTY, so Braid status
uses the official list command first and then reads only the isolated installed
extension manifest as a discovery fallback. The native `link` command is
documented for development but is not used to share generated Braid adapter
assets.

The intended remote command is:

```text
gemini extensions install https://github.com/ting10688/Braid
```

The remote form is valid only after this content exists on the default branch.
Local validation and installation must pass first, followed by a post-merge
remote smoke.

### Live lifecycle contract carried forward

The 0.40.0 research probe observed `SessionStart`, `BeforeAgent`, `AfterTool`,
and `AfterAgent`. `AfterAgent` deny caused an additional turn and a subsequent
pass. Folder trust remains a user decision. The final scan is authoritative
for shell-based mutation.

## Shared runtime and public boundary

One canonical standard-library Node.js runtime will:

1. read one bounded JSON payload from stdin;
2. locate `braid` on `PATH` without a shell;
3. run one foreground `braid growth hook --host <host>` process with a bounded
   timeout;
4. forward exactly one native JSON value to stdout and diagnostics only to
   stderr;
5. emit the host's fail-open JSON if Braid is missing, incompatible, malformed,
   nonzero, or timed out.

The shared Codex/Copilot directory and dedicated Claude directory each require
one physical runtime copy. A deterministic synchronization script owns both,
and validation fails when either differs from the canonical source. Gemini
invokes the canonical file directly from the repository-root extension. No
symlink, MCP server, or new runtime dependency is needed.

`packages/guard` remains the sole Growth policy owner. A narrow host-neutral
hook bridge maps native payloads into the existing `GrowthGuardLifecycle` and
maps its context/check/final result back to each native response. Host adapters
do not inspect prompts, transcripts, model output, credentials, account data,
or request identifiers.

The native commands are thin, read-only workflows over Braid CLI:

- `setup`: locate and version-check Braid, inspect initialization and Growth
  configuration, identify adapter discovery, and print exactly one next step;
- `status`: show redacted host/Braid/project/adapter/session compatibility;
- `check`: run the existing non-mutating Growth comparison with a manual or
  current session;
- `help`: explain automatic operation, setup/status/check, disable/uninstall,
  troubleshooting, and documentation.

No native package silently downloads Braid or edits project configuration.
`braid init` and enabling `growthMode` remain explicit user actions.

## Implementation and verification status

The native contracts express Braid's required lifecycle without global
settings, an MCP server, prompt-hook blocking, or a second Growth policy
engine. The implementation covers Codex, Claude Code, Gemini CLI, and local
Copilot CLI.

Verified local package results on 2026-07-18 and 2026-07-19:

- all four manifests were accepted by their installed host CLIs;
- all four packages completed isolated discovery, install, list, setup,
  uninstall, and reinstall; Gemini additionally completed disable/enable and
  Copilot completed local update;
- all four adapters ran the real Growth engine in a normal checkout and a
  linked worktree through baseline, non-relevant change, relevant cycle,
  first final block, bounded unchanged retry, repair, and final pass;
- source, HEAD, index, and worktree registration stayed unchanged by Braid;
- malformed output, nonzero exit, timeout, missing Braid, bounded input,
  sensitive-data scanning, copied-asset synchronization, and direct-child
  cleanup passed deterministic tests;
- native Codex detects the legacy manual adapter, fails that duplicate
  invocation open, and reports `braid growth uninstall codex`.
- native Claude and its manual fallback complete exactly one lifecycle when
  both are present and report `braid growth uninstall claude`.

Claude's authenticated package-level live smoke passed without changing global
settings, authentication, installed-plugin registry, or marketplace registry.
The other hosts retain their earlier authenticated contract evidence. Remote
Claude installation from Arthur's feature branch passed; the final upstream
owner/repository path remains a post-merge smoke.
