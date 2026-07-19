---
name: help
description: Explain Braid native Codex setup, automatic Growth Mode, status, check, uninstall, and troubleshooting.
---

# Braid help

Explain these commands concisely:

- `$braid:setup` checks the CLI and prints the next explicit project step.
- `$braid:status` reports the native adapter and Growth Mode state.
- `$braid:check` runs a read-only manual comparison.
- Normal work is automatic after the project is initialized and Growth Mode is
  explicitly enabled.

To disable an individual hook, use Codex `/hooks`; to uninstall the plugin,
run `codex plugin remove braid@braid`. The legacy fallback remains
`braid growth install codex --confirm`. If both adapters are present, run
`braid growth uninstall codex` to keep only the native plugin.

Documentation:

- https://github.com/ting10688/Braid/blob/main/docs/native-agent-plugins.md
- https://github.com/ting10688/Braid/blob/main/docs/growth-mode.md
