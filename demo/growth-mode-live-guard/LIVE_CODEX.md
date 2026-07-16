# Optional live Codex walkthrough

This optional path requires an installed, authenticated Codex CLI whose hooks capability is supported by
`braid growth status`. Model behavior is nondeterministic; use the deterministic `./braid-demo` flow for
repeatable judging.

1. Copy `demo/fixture` to a disposable directory and initialize one Git commit.
2. From the distribution, run `node bin/braid.mjs growth install codex --path <repo> --dry-run`.
3. Review the proposed repository-local `.codex/hooks.json`, then repeat with `--confirm`.
4. Start Codex inside the disposable repository and use this prompt:

   > Add `describeOrder()` in notifications by importing `placeOrder()` from orders. If Braid reports a
   > cycle, remove the reverse dependency and make `describeOrder(label)` return its argument. Do not run
   > migrations or commit.

5. Observe the same-session Braid finding and final pass. Codex may choose a different edit sequence; no
   identical transcript is promised.
6. Remove only Braid-owned hooks with
   `node bin/braid.mjs growth uninstall codex --path <repo>` and delete the disposable repository.

Codex requires repository-local hooks to be explicitly reviewed and trusted. Installation cannot grant
that trust and does not alter global hooks.
