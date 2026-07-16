# Braid {{VERSION}} demo bundle

This archive contains a standalone Node.js 22 CLI and the deterministic Growth Mode judge demo. It
does not need pnpm, a source checkout, `node_modules`, an OpenAI account, a Codex login, or network
access.

## Run the judge demo

On macOS or Linux:

```bash
./braid-demo
```

On any supported platform with Node.js 22 and Git 2.39 or newer:

```bash
node ./demo/run-demo.mjs
```

Pass `--keep` to preserve the temporary demo repository for inspection. Without it, the demo always
cleans up its temporary directory.

## Run the CLI

```bash
./bin/braid --help
node ./bin/braid.mjs --version
```

On Windows Command Prompt, use `bin\braid.cmd --help`.

## Verify the bundle

`manifest.json` records the deterministic logical payload and SHA-256 digest of every payload file.
`SHA256SUMS` includes those files plus the manifest. Licensing is in `LICENSE` and
`THIRD_PARTY_NOTICES.md`.

See `demo/README.md` for the exact scenario, expected output, optional live-Codex walkthrough, and
known limitations.
