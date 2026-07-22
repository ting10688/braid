---
description: Explain Braid Claude installation, operation, and troubleshooting
---

Explain the preferred native installation (`/plugin marketplace add ting10688/Braid`, `/plugin install braid@braid`), `/braid:setup`, automatic lifecycle hooks, `/braid:status`, `/braid:check`, and the explicit manual fallback (`braid growth install claude --dry-run`, then `--confirm`). State that Claude Code support is exact-version scoped to local 2.1.215 on Darwin arm64, the standalone Braid CLI is required, and the plugin never downloads it or silently enables Growth Mode. Explain `/reload-plugins`, uninstall, and duplicate remediation with `braid growth uninstall claude`.
