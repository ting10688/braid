# Why Claude support uses the shared v0.6 runtime

Date: 2026-07-19

## Boundary

Claude support is a protocol and packaging adapter over the existing
`GrowthGuardLifecycle`. Architecture analysis, baseline ownership, finding
classification, final blocking, and finite retry state remain in the shared
Growth Mode engine. The marketplace plugin contains metadata, four commands,
four hook declarations, and the same bounded standard-library runtime used by
the other v0.6 native packages.

This avoids a second analyzer and keeps Braid as an explicit standalone CLI.
The plugin never downloads Braid, initializes a repository, enables Growth
Mode, grants trust, or executes a migration.

## Exact contract and schemas

The authenticated gate proved local Claude Code 2.1.215 on Darwin arm64. The
adapter therefore rejects every other version until it completes the same
lifecycle. During verification the active binary advanced to 2.1.216 and then
2.1.217; Braid returned `{}` fail-open rather than inferring compatibility from
proximity.

Live payload evidence showed that `SessionStart` omits `permission_mode`, while
`UserPromptSubmit`, `PostToolUse`, and `Stop` include it. Separate schemas make
that asymmetry explicit. Only session, worktree, event, mutation-tool name, and
Stop state reach the adapter. Prompt text, tool input/output, transcript paths,
model responses, account data, credentials, and request identifiers are not
retained.

## Native package shape

Claude auto-discovers `hooks/hooks.json`. The `.claude-plugin/plugin.json`
manifest intentionally does not declare that file again because
`manifest.hooks` is for additional hook files and would register every handler
twice. Both the deterministic manifest validator and a package regression test
enforce this rule.

Hook commands resolve the copied runtime with `${CLAUDE_PLUGIN_ROOT}`. The
runtime reads one bounded JSON value, locates `braid` on `PATH` without a shell,
runs one foreground child with a timeout, forwards one validated JSON response,
and emits only protocol-safe fail-open output on failure. Claude's 35-second
hook timeout leaves five seconds beyond the runtime's 30-second child timeout
for bounded termination and fail-open output.

The existing plugin root also serves Copilot CLI and contains its own root
manifest and TOML commands. Claude interprets those components too, which
exposes eight duplicate commands even when command directories are separated.
Claude therefore has a dedicated `plugins/braid-claude/` root. The asset-sync
check keeps both physical runtime copies byte-identical to the canonical file.

## Manual fallback and duplicate ownership

Marketplace installation is preferred. The manual fallback edits only the
main checkout's `.claude/settings.local.json`, even from a linked worktree. It
requires explicit confirmation, preserves unrelated settings, refuses
malformed or ambiguous ownership, uses atomic replacement, and creates a
content-addressed backup when modifying existing content.

Native and manual hooks can otherwise evaluate the same Stop twice. A
worktree-scoped coordinator hashes the provider session identifier, lets native
`SessionStart` establish authority, defers manual start until prompt submission,
and creates atomic event/report claims. Persisted records contain no raw
session identifier or report fingerprint. The exact remediation is
`braid growth uninstall claude`.

## Verification evidence

The production package observed:

```text
SessionStart(context)
UserPromptSubmit(allow)
Stop(block, stop_hook_active=false)
PostToolUse(Edit, allow)
Stop(allow, stop_hook_active=true)
```

A separate file-tool mutation proved early detection; a shell mutation bypassed
the matcher and proved the final scan authoritative. Normal, duplicate-adapter,
and linked-worktree runs completed one block/repair/pass lifecycle and returned
source and Git state to clean. Isolated marketplace add/install/list/details,
enable/disable/update/uninstall/reinstall and a remote feature-branch install
also passed without changing global settings or authentication state.

## Rewritten upstream base

The requested upstream branch was force-rewritten during implementation and
gained a shared Codex/Gemini/Copilot native runtime with no common Git history
to the original working branch. The original branch remains on Arthur's fork as
a recoverable backup. This integration branch starts from the rewritten base
and ports only the verified Claude-specific modules and package surface, which
keeps the eventual pull request reviewable and avoids an unrelated-history
merge or force-push.
