# Braid judge demo

This deterministic demo runs the real bundled Braid Growth Mode implementation without an OpenAI
account, Codex login, network access, pnpm, dependency installation, or a Braid source checkout.

Requirements:

- macOS or Linux; Windows can use the Node command below;
- Node.js 22 or newer;
- Git 2.39 or newer on `PATH`.

From the unpacked distribution:

```bash
./braid-demo
```

On Windows or when the shell launcher is unavailable:

```bash
node ./demo/run-demo.mjs
```

The run normally takes under 15 seconds. It creates a temporary copy of the healthy fixture, captures a
real Growth Mode baseline, applies a clearly labelled demo action that creates a cycle, verifies a real
`block`, demonstrates finite Stop-equivalent behavior, applies a separate demo repair action, and verifies
the final `pass`. Braid itself does not write source or protected Git state.

Temporary files are removed automatically. Add `--keep` to either command to retain the temporary
repository for inspection; the printed path can then be deleted manually.

The bad change and repair are deterministic demo setup scripts, not Braid-generated edits. The reports,
fingerprints, cycle evidence, cache behavior, and final policy come from the same bundled Braid CLI used
outside the demo. Static analysis is limited to the supported TypeScript architecture rules documented by
Braid; this is not a proof of general code correctness.

Judges who already have a supported Codex CLI can optionally follow `LIVE_CODEX.md` after completing the
account-free path.
