# Installing Braid

Braid's supported end-user distribution is the standalone Node.js 22 release archive, installed and
managed by the repository's POSIX shell scripts. It does not require a repository clone, pnpm,
`node_modules`, workspace packages, `pnpm link`, `PNPM_HOME`, or `sudo`.

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/ting10688/Braid/main/install.sh | sh
```

To inspect the script first:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/ting10688/Braid/main/install.sh \
  -o install-braid.sh

less install-braid.sh
sh install-braid.sh
```

After opening a new shell, or immediately when the selected bin directory is already in `PATH`:

```bash
braid --version
braid --help
```

## Native agent adapters

The current v0.6.0 native production scope is Codex, Gemini CLI, and local
GitHub Copilot CLI. Install their native plugin or extension separately after
installing Braid; that host installation does not initialize a project or
enable Growth Mode. Claude Code production support is deferred from this
release, while its compatibility research remains documented. See the
[native agent plugin guide](native-agent-plugins.md) and
[compatibility report](agent-compatibility.md).

## Requirements and supported platforms

The installer supports:

- macOS arm64;
- macOS x86_64;
- Linux x86_64.

It requires Node.js 22 or newer and Git 2.39 or newer. The installer checks both before making a
persistent installation and reports the detected version and required minimum when either is too old.
It does not install or upgrade either tool.

The POSIX installer does not support Windows. On Windows, download the standalone zip archive from
the matching GitHub Release and follow [Manual archive use](#manual-archive-use).

## Default layout

The installation root is `${XDG_DATA_HOME:-$HOME/.local/share}/braid`. The binary directory is
`${XDG_BIN_HOME:-$HOME/.local/bin}`.

```text
~/.local/share/braid/
├── versions/
│   ├── 0.5.1/
│   └── 0.6.0/
├── current -> versions/0.6.0
├── previous -> versions/0.5.1
└── install-manifest.json

~/.local/bin/braid -> ~/.local/share/braid/current/bin/braid
```

`previous` exists only when there was an earlier active version. The manifest records installer-owned
paths and installed release metadata; it contains no credentials or download authorization data.

## Installer options

Run a downloaded script directly when passing options:

```bash
sh install-braid.sh --version 0.6.0
sh install-braid.sh --version v0.6.0
sh install-braid.sh --install-dir "$HOME/custom/braid"
sh install-braid.sh --bin-dir "$HOME/custom/bin"
sh install-braid.sh --dry-run
sh install-braid.sh --no-path-update
sh install-braid.sh --force-path-update
sh install-braid.sh --keep-downloads
sh install-braid.sh --repository ting10688/Braid
sh install-braid.sh --help
```

With a pipe, pass arguments to `sh` after `-s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/ting10688/Braid/main/install.sh | \
  sh -s -- --version 0.6.0 --no-path-update
```

`BRAID_VERSION`, `BRAID_INSTALL_DIR`, `BRAID_BIN_DIR`, `BRAID_REPOSITORY`, and
`BRAID_DOWNLOAD_BASE_URL` provide environment overrides; command-line flags take precedence.
`BRAID_DOWNLOAD_BASE_URL` is intended for deterministic local or CI fixtures and never disables
checksum verification.

Without `--version`, the installer resolves the latest stable GitHub Release, ignoring drafts and
prereleases. `--version` accepts either `0.6.0` or `v0.6.0` and resolves exactly that immutable release.
It never falls back to another version. Use `--dry-run` to inspect the planned operations without
changing files.

## Install, reinstall, upgrade, and downgrade

On first install, the selected release is downloaded, verified, extracted, smoke-tested, and moved
under `versions/<version>` before `current` is activated.

Running the installer again for the active version is idempotent. A valid installed copy is reused
without redownloading; missing installer-owned links or manifest fields are repaired without adding a
second PATH block.

Running without `--version` upgrades only when a newer stable release is available. The new version is
installed beside the old one and validated before activation. The former active version becomes
`previous` and remains available.

A downgrade requires an explicit version:

```bash
sh install-braid.sh --version 0.5.1
```

For example, that command explicitly returns a later installation to v0.5.1. The requested release is
verified normally, the current version is preserved as `previous`, and the installer prints a visible
downgrade notice. Latest-release resolution never silently downgrades.

Activation uses atomic symlink replacement. If staged checks fail, the active installation is never
switched. If a post-activation check fails, the installer restores the former `current` target and
Braid-owned binary link, then exits nonzero. Existing version contents are not modified during a failed
upgrade.

## PATH integration

If the selected bin directory is already in `PATH`, no shell file is changed. Otherwise the installer
supports zsh and bash and updates one appropriate user-owned login file with one bounded block:

```sh
# >>> braid installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< braid installer <<<
```

For a custom bin directory, the installer writes a safely quoted equivalent. It changes only that
owned block, preserves unrelated content, refuses ambiguous duplicate blocks, and creates a
content-addressed backup before changing an existing file. It never sources the file automatically.
Restart the shell or run the exact `export PATH="...:$PATH"` command printed after installation.

Use `--no-path-update` to leave shell files untouched. `--force-path-update` permits replacing the
single owned PATH block when needed; it does not permit overwriting an unknown `braid` executable.

If `braid` is not found after installation, verify the selected directory and current `PATH`:

```bash
printf '%s\n' "$PATH"
ls -l "${XDG_BIN_HOME:-$HOME/.local/bin}/braid"
```

Then open a new shell or use the command printed by the installer.

## Verification and conflicts

For release `<version>`, the installer requires
`braid-v<version>-demo-node22.tar.gz` and `SHA256SUMS` from the same release. It verifies the archive
with `sha256sum` or `shasum -a 256` and refuses missing, malformed, conflicting, or mismatched checksum
entries. When neither platform utility exists, it uses the already-required Node.js crypto
implementation. An archive is never installed without successful SHA-256 verification.

Before extraction, the installer rejects absolute paths, parent traversal, escaping links, unsafe
special files, conflicting duplicate paths, and an unexpected top-level structure. Before activation,
it verifies the release manifest and required bundle files, then runs `bin/braid --version` and
`bin/braid --help` from the staged directory. The reported version must match the selected release.

If the target binary path already contains a regular file, directory, or unrelated symlink, the
installer refuses to overwrite or move it. Inspect the reported path and either remove it yourself if
you own it, choose another `--bin-dir`, or keep using the existing command. No installer flag authorizes
overwriting an unknown binary.

## Uninstall

Download the tracked uninstaller before running it:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/ting10688/Braid/main/uninstall.sh \
  -o uninstall-braid.sh

less uninstall-braid.sh
sh uninstall-braid.sh
```

Its complete interface is:

```bash
sh uninstall-braid.sh
sh uninstall-braid.sh --install-dir "$HOME/.local/share/braid"
sh uninstall-braid.sh --bin-dir "$HOME/.local/bin"
sh uninstall-braid.sh --keep-versions
sh uninstall-braid.sh --keep-path
sh uninstall-braid.sh --dry-run
sh uninstall-braid.sh --help
```

The uninstaller validates `install-manifest.json` and every owned path before mutation. It removes only
the Braid-owned binary symlink, bounded PATH block, recorded version directories, activation links, and
manifest. Unknown binaries, unrecorded version directories, ambiguous paths, and unrelated shell
content are preserved. Repeated uninstall is safe; `--keep-versions` preserves recorded version
directories, and `--keep-path` preserves the owned PATH block.

Project-local `.braid` state and repository-local `.codex/hooks.json` are never removed. Node.js, Git,
Codex, pnpm, and unrelated executables are untouched. The uninstaller does not search the home
directory for projects.

Repository-local Growth Mode hooks are not removed automatically. Run
`braid growth uninstall codex` inside each affected repository before uninstalling Braid when desired.

## Manual archive use

For offline or installer-independent use, download these two files for one immutable release on a
connected machine:

```text
braid-v<version>-demo-node22.tar.gz
SHA256SUMS
```

Transfer both files together. In their directory, select the archive's exact checksum line and verify
it with one available platform command:

```bash
sha256sum -c SHA256SUMS --ignore-missing
# or on macOS
expected=$(awk '$2 == "braid-v<version>-demo-node22.tar.gz" { print $1 }' SHA256SUMS)
test -n "$expected" && test "$(shasum -a 256 braid-v<version>-demo-node22.tar.gz | awk '{ print $1 }')" = "$expected"
```

Extract the verified archive into a directory you own, then run its CLI directly:

```bash
tar -xzf braid-v<version>-demo-node22.tar.gz
./braid-v<version>-demo-node22/bin/braid --version
./braid-v<version>-demo-node22/bin/braid --help
```

This manual layout is not registered in `install-manifest.json`; upgrades and removal are manual. On
Windows, use the matching zip archive and `bin\braid.cmd --help` or
`node .\bin\braid.mjs --help` with Node.js 22 and Git 2.39 or newer.

## Development from source

Source installation is a contributor workflow, separate from standalone end-user installation. Use
the pnpm version pinned by the repository:

```bash
git clone https://github.com/ting10688/Braid.git
cd Braid
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm braid --help
```

An optional contributor-only global link is available after the build:

```bash
pnpm --filter @braid/cli link --global
```

The CLI workspace package is private and uses `workspace:*` dependencies; it is not the standalone
installation channel.

## Security and trust model

The one-line command downloads the installer from the repository's `main` branch, while the installer
resolves and verifies immutable stable release assets. Use the inspect-first flow when you want to
review the current script before executing it. HTTPS and SHA-256 verification protect transfer
integrity; checksums do not replace trust in the repository and its GitHub Release publisher.

The installer trusts the local operating system, POSIX utilities, Node.js, Git, selected user-owned
shell file, repository identity, and release publisher. It does not use `sudo`, alter global Git
configuration, execute a second unverified installer, or scan unrelated user data.

## Known limitations

- Supported automated installation is limited to macOS arm64, macOS x86_64, and Linux x86_64.
- Node.js and Git must already meet the minimum versions.
- Release installation requires HTTPS access to GitHub unless a verified archive is used manually.
- Lifecycle commands are external scripts; the `braid` CLI has no self-update or self-uninstall
  commands.
- v0.5.1 is the first release with a launcher that supports the required activation symlink. Historical
  v0.5.0 and older standalone archives remain manual-archive distributions; attempting to activate one
  with this installer fails smoke testing and leaves the current installation unchanged. Synthetic
  previous-release fixtures cover the upgrade and explicit-downgrade transaction itself.
- Package-manager installation channels and shell completion are not provided.
- The uninstaller intentionally does not discover or remove repository-local Growth Mode hooks.
