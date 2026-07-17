#!/bin/sh
set -eu

platform_name=$(uname -s 2>/dev/null || printf 'unknown')
platform_arch=$(uname -m 2>/dev/null || printf 'unknown')
case "$platform_name/$platform_arch" in
  Darwin/arm64|Darwin/x86_64|Linux/x86_64) ;;
  MINGW*/*|MSYS*/*|CYGWIN*/*|Windows_NT/*)
    echo "braid installer: Windows is not supported; use the standalone archive instructions in docs/installation.md." >&2
    exit 1
    ;;
  *)
    echo "braid installer: unsupported platform $platform_name/$platform_arch; supported platforms are macOS arm64/x86_64 and Linux x86_64." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "braid installer: Node.js was not found; install Node.js 22 or newer and retry." >&2
  exit 1
fi
node_version=$(node --version 2>/dev/null || true)
node_major=$(printf '%s\n' "$node_version" | sed 's/^v//' | cut -d. -f1)
case $node_major in
  ''|*[!0-9]*)
    echo "braid installer: could not parse Node.js version '$node_version'; Node.js 22 or newer is required." >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  echo "braid installer: detected Node.js $node_version; minimum required version is 22. Install a newer Node.js and retry." >&2
  exit 1
fi

exec node --input-type=module - "$@" <<'BRAID_INSTALLER_NODE'
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const env = process.env;
const markerStart = "# >>> braid installer >>>";
const markerEnd = "# <<< braid installer <<<";
const fail = (message) => {
  throw new Error(message);
};
process.on("uncaughtException", (error) => {
  process.stderr.write(`braid installer: ${error.message}\n`);
  process.exit(1);
});
const exists = async (input) => {
  try {
    return await lstat(input);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};
const rejectMalformed = (value, label) => {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must not be empty`);
  if (/[\0\r\n]/.test(value)) fail(`${label} contains invalid characters`);
  return value;
};

const options = {
  version: Object.hasOwn(env, "BRAID_VERSION") ? env.BRAID_VERSION : undefined,
  installDir:
    env.BRAID_INSTALL_DIR ??
    path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "share"), "braid"),
  binDir:
    env.BRAID_BIN_DIR ??
    (env.XDG_BIN_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "bin")),
  repository: env.BRAID_REPOSITORY ?? "ting10688/Braid",
  downloadBaseUrl: env.BRAID_DOWNLOAD_BASE_URL,
  explicitVersion: Object.hasOwn(env, "BRAID_VERSION"),
  dryRun: false,
  noPathUpdate: false,
  forcePathUpdate: false,
  keepDownloads: false,
};
const valueAfter = (index, flag) => {
  if (index + 1 >= args.length) fail(`${flag} requires a value`);
  return rejectMalformed(args[index + 1], flag);
};
let help = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = rejectMalformed(args[index], "argument");
  switch (argument) {
    case "--version":
      options.version = valueAfter(index, argument);
      options.explicitVersion = true;
      index += 1;
      break;
    case "--install-dir":
      options.installDir = valueAfter(index, argument);
      index += 1;
      break;
    case "--bin-dir":
      options.binDir = valueAfter(index, argument);
      index += 1;
      break;
    case "--repository":
      options.repository = valueAfter(index, argument);
      index += 1;
      break;
    case "--dry-run":
      options.dryRun = true;
      break;
    case "--no-path-update":
      options.noPathUpdate = true;
      break;
    case "--force-path-update":
      options.forcePathUpdate = true;
      break;
    case "--keep-downloads":
      options.keepDownloads = true;
      break;
    case "--help":
    case "-h":
      help = true;
      break;
    default:
      fail(`unknown option: ${argument}`);
  }
}
if (help) {
  process.stdout.write(`Install a verified standalone Braid release.

Usage: install.sh [options]

  --version <version>      Install exactly v<version>
  --install-dir <path>     Installation root
  --bin-dir <path>         Binary link directory
  --dry-run                Show the resolved plan without mutation
  --no-path-update         Do not edit a shell startup file
  --force-path-update      Update the owned PATH block even when already in PATH
  --keep-downloads         Keep the private download workspace
  --repository <owner/repo>
  --help
`);
  process.exit(0);
}
if (options.noPathUpdate && options.forcePathUpdate)
  fail("--no-path-update and --force-path-update cannot be combined");

const normalizeVersion = (input) => {
  const value = rejectMalformed(input, "version").replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    fail(`invalid stable version: ${input}`);
  return value;
};
if (options.version !== undefined) options.version = normalizeVersion(options.version);
const repositoryMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(
  rejectMalformed(options.repository, "repository"),
);
if (!repositoryMatch || repositoryMatch.slice(1).some((part) => part === "." || part === ".."))
  fail(`invalid repository identifier: ${options.repository}`);
if (options.downloadBaseUrl) {
  rejectMalformed(options.downloadBaseUrl, "BRAID_DOWNLOAD_BASE_URL");
  const parsed = new URL(options.downloadBaseUrl);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
    fail("BRAID_DOWNLOAD_BASE_URL must be an HTTP(S) URL without credentials");
  options.downloadBaseUrl = parsed.href.replace(/\/$/, "");
}

const supported =
  (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)) ||
  (process.platform === "linux" && process.arch === "x64");
if (!supported) {
  const windows = process.platform === "win32";
  fail(
    windows
      ? "Windows installers are not supported; use the standalone archive instructions in docs/installation.md."
      : `unsupported platform: ${process.platform}/${process.arch}; supported platforms are macOS arm64/x64 and Linux x64.`,
  );
}

const nodeVersion = process.versions.node;
if (Number(nodeVersion.split(".")[0]) < 22)
  fail(`detected Node.js ${nodeVersion}; minimum required version is 22. Install a newer Node.js and retry.`);
let gitVersion;
try {
  const result = await execFile("git", ["--version"], { encoding: "utf8" });
  gitVersion = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(result.stdout);
} catch {
  fail("Git was not found; install Git 2.39 or newer and retry.");
}
if (!gitVersion)
  fail("could not parse the detected Git version; Git 2.39 or newer is required.");
if (Number(gitVersion[1]) < 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) < 39))
  fail(
    `detected Git ${gitVersion.slice(1).filter(Boolean).join(".")}; minimum required version is 2.39. Install a newer Git and retry.`,
  );

const homeInput = rejectMalformed(env.HOME ?? os.homedir(), "HOME");
const home = await realpath(path.resolve(homeInput)).catch(() => path.resolve(homeInput));
const canonicalFuture = async (input, label) => {
  rejectMalformed(input, label);
  const absolute = path.resolve(input);
  const direct = await exists(absolute);
  if (direct?.isSymbolicLink())
    fail(`${label} must not be a symlink: ${absolute}`);
  let ancestor = absolute;
  const tail = [];
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail(`${label} has no existing ancestor: ${input}`);
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const resolved = path.join(await realpath(ancestor), ...tail);
  return resolved;
};
const installRoot = await canonicalFuture(options.installDir, "install directory");
const binDirectory = await canonicalFuture(options.binDir, "bin directory");
if (installRoot === path.parse(installRoot).root || installRoot === home)
  fail("install directory must not be / or HOME");
if (binDirectory === path.parse(binDirectory).root)
  fail("bin directory must not be /");
if (binDirectory === installRoot || binDirectory.startsWith(`${installRoot}${path.sep}`))
  fail("bin directory must not be inside the installation root");

const assertWritableTarget = async (target, label) => {
  let ancestor = target;
  let metadata = await exists(ancestor);
  while (!metadata) {
    ancestor = path.dirname(ancestor);
    metadata = await exists(ancestor);
  }
  if (!metadata.isDirectory()) fail(`${label} ancestor is not a directory: ${ancestor}`);
  try {
    await access(ancestor, fsConstants.W_OK);
  } catch {
    fail(`${label} is not writable or safely creatable: ${target}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    fail(`${label} ancestor is not owned by the current user: ${ancestor}`);
};
await assertWritableTarget(installRoot, "install directory");
await assertWritableTarget(binDirectory, "bin directory");

const versionsRoot = path.join(installRoot, "versions");
const currentLink = path.join(installRoot, "current");
const previousLink = path.join(installRoot, "previous");
const manifestPath = path.join(installRoot, "install-manifest.json");
const binaryLink = path.join(binDirectory, "braid");
const expectedBinary = path.join(installRoot, "current", "bin", "braid");
const expectedBinaryTarget = path.relative(binDirectory, expectedBinary);

const verifyVersionsRoot = async (required = false) => {
  const metadata = await exists(versionsRoot);
  if (!metadata) {
    if (required) fail(`missing installer-owned versions directory: ${versionsRoot}`);
    return;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (await realpath(versionsRoot)) !== versionsRoot
  )
    fail(`versions directory is not a canonical user-owned directory: ${versionsRoot}`);
};
await verifyVersionsRoot();

const atomicWrite = async (file, contents, mode = 0o600) => {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
const atomicSymlink = async (link, target) => {
  const temporary = `${link}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
const linkTargetWithinVersions = async (link, required = false) => {
  const metadata = await exists(link);
  if (!metadata) {
    if (required) fail(`missing owned link: ${link}`);
    return undefined;
  }
  if (!metadata.isSymbolicLink()) fail(`expected an installer-owned symlink: ${link}`);
  const raw = await readlink(link);
  const resolved = path.resolve(path.dirname(link), raw);
  if (path.dirname(resolved) !== versionsRoot || !/^\d+\.\d+\.\d+$/.test(path.basename(resolved)))
    fail(`symlink escapes the Braid versions directory: ${link} -> ${raw}`);
  return { raw, version: path.basename(resolved), resolved };
};
const binaryState = async () => {
  const metadata = await exists(binaryLink);
  if (!metadata) return undefined;
  if (!metadata.isSymbolicLink())
    fail(`binary conflict at ${binaryLink}; remove or relocate the unrelated path, or choose --bin-dir.`);
  const raw = await readlink(binaryLink);
  if (path.resolve(binDirectory, raw) !== expectedBinary)
    fail(`binary conflict at ${binaryLink}; the unrelated symlink was preserved. Choose another --bin-dir or inspect it manually.`);
  return raw;
};

let oldManifestText;
let oldManifest;
if (await exists(manifestPath)) {
  oldManifestText = await readFile(manifestPath, "utf8");
  try {
    oldManifest = JSON.parse(oldManifestText);
  } catch {
    fail(`invalid installer manifest: ${manifestPath}`);
  }
  if (
    oldManifest.schemaVersion !== 1 ||
    oldManifest.installMethod !== "release-script" ||
    oldManifest.installRoot !== installRoot ||
    oldManifest.binDirectory !== binDirectory ||
    oldManifest.binaryLink !== binaryLink ||
    !Array.isArray(oldManifest.installedVersions)
  )
    fail(`installer manifest ownership does not match the requested paths: ${manifestPath}`);
  if (oldManifest.repository !== options.repository)
    fail(`installer manifest belongs to repository ${oldManifest.repository}; refusing to replace it.`);
  const seen = new Set();
  for (const installed of oldManifest.installedVersions) {
    if (!installed || !/^\d+\.\d+\.\d+$/.test(installed.version) || seen.has(installed.version))
      fail(`invalid installedVersions entry in ${manifestPath}`);
    seen.add(installed.version);
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(oldManifest.activeVersion) ||
    !seen.has(oldManifest.activeVersion) ||
    (oldManifest.previousVersion !== null &&
      (!/^\d+\.\d+\.\d+$/.test(oldManifest.previousVersion) ||
        !seen.has(oldManifest.previousVersion)))
  )
    fail(`installer manifest version ownership is incomplete: ${manifestPath}`);
}
const activeBefore = await linkTargetWithinVersions(currentLink);
const previousBefore = await linkTargetWithinVersions(previousLink);
const binaryBefore = await binaryState();
if (oldManifest && activeBefore && oldManifest.activeVersion !== activeBefore.version)
  fail("installer manifest activeVersion does not match current");
if (!oldManifest && previousBefore)
  fail("previous link exists without installer manifest ownership");
if (oldManifest?.pathBlockInstalled) {
  if (
    typeof oldManifest.pathFile !== "string" ||
    path.dirname(oldManifest.pathFile) !== home ||
    !new Set([".zshrc", ".bashrc", ".bash_profile"]).has(
      path.basename(oldManifest.pathFile),
    )
  )
    fail("installer manifest PATH ownership is invalid");
  const pathMetadata = await exists(oldManifest.pathFile);
  if (
    pathMetadata &&
    (!pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        pathMetadata.uid !== process.getuid()))
  )
    fail("installer manifest PATH file is not a user-owned regular file");
}

const parseSemanticVersion = (value) => value.split(".").map(Number);
const compareVersions = (left, right) => {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};
const apiRoot = options.downloadBaseUrl ?? "https://api.github.com";
const apiUrl = options.version
  ? `${apiRoot}/repos/${options.repository}/releases/tags/v${options.version}`
  : `${apiRoot}/repos/${options.repository}/releases/latest`;
const fetchResponse = async (url, label) => {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "braid-installer" },
      redirect: "follow",
    });
  } catch (error) {
    fail(`${label} failed: ${error.message}`);
  }
  if (!response.ok) {
    const rateLimit = response.status === 403 || response.status === 429;
    fail(
      `${label} failed with HTTP ${response.status}${rateLimit ? "; GitHub API rate limit may have been reached—retry later" : ""}.`,
    );
  }
  return response;
};
let release;
try {
  release = await (await fetchResponse(apiUrl, "release resolution")).json();
} catch (error) {
  if (error.message?.startsWith("release resolution")) throw error;
  fail(`release resolution returned malformed JSON: ${error.message}`);
}
if (
  !release ||
  typeof release.tag_name !== "string" ||
  release.draft !== false ||
  release.prerelease !== false ||
  !Array.isArray(release.assets)
)
  fail("release resolution returned a draft, prerelease, or malformed API response");
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name))
  fail(`release API returned a non-canonical stable tag: ${release.tag_name}`);
const selectedVersion = normalizeVersion(release.tag_name);
if (options.version && selectedVersion !== options.version)
  fail(`release API returned ${release.tag_name}; expected v${options.version}`);
if (!options.explicitVersion && activeBefore && compareVersions(selectedVersion, activeBefore.version) < 0)
  fail(`latest stable release v${selectedVersion} is older than active v${activeBefore.version}; refusing an implicit downgrade.`);
const artifactName = `braid-v${selectedVersion}-demo-node22`;
const archiveName = `${artifactName}.tar.gz`;
const assetUrl = (name) => {
  const matches = release.assets.filter(
    (asset) => asset?.name === name && typeof asset.browser_download_url === "string",
  );
  if (matches.length !== 1) fail(`release v${selectedVersion} must contain exactly one ${name} asset`);
  const parsed = new URL(matches[0].browser_download_url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
    fail(`release asset URL is not safe for ${name}`);
  return parsed.href;
};
const archiveUrl = assetUrl(archiveName);
const checksumUrl = assetUrl("SHA256SUMS");

if (options.dryRun) {
  process.stdout.write(`Braid installer dry run
Version: ${selectedVersion}
Repository: ${options.repository}
Install root: ${installRoot}
Bin directory: ${binDirectory}
Archive: ${archiveName}
No files were changed.
`);
  process.exit(0);
}

const download = async (url, destination, label) => {
  const response = await fetchResponse(url, label);
  const contents = Buffer.from(await response.arrayBuffer());
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== contents.length)
    fail(`${label} was interrupted: expected ${length} bytes, received ${contents.length}`);
  if (contents.length === 0) fail(`${label} is empty`);
  await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
};
const parseChecksums = (contents) => {
  const entries = new Map();
  for (const line of contents.split(/\n/)) {
    if (line === "") continue;
    if (line.endsWith("\r")) fail("SHA256SUMS contains malformed line endings");
    const match = /^([A-Fa-f0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!match || /[\r\n]/.test(match[2])) fail(`malformed SHA256SUMS entry: ${line}`);
    const digest = match[1].toLowerCase();
    const previous = entries.get(match[2]);
    if (previous && previous !== digest)
      fail(`duplicate checksum entries disagree for ${match[2]}`);
    entries.set(match[2], digest);
  }
  const digest = entries.get(archiveName);
  if (!digest) fail(`SHA256SUMS has no entry for ${archiveName}`);
  return digest;
};
const digestFile = async (file) => {
  for (const [command, arguments_] of [
    ["sha256sum", [file]],
    ["shasum", ["-a", "256", file]],
  ]) {
    try {
      const result = await execFile(command, arguments_, { encoding: "utf8" });
      const match = /^([A-Fa-f0-9]{64})[ \t]/.exec(result.stdout);
      if (!match) fail(`${command} returned malformed SHA-256 output`);
      return match[1].toLowerCase();
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error.message?.includes("malformed SHA-256 output")) throw error;
      fail(`${command} failed while verifying the archive: ${error.message}`);
    }
  }
  return createHash("sha256").update(await readFile(file)).digest("hex");
};

const requiredDistributionFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SHA256SUMS",
  "bin/braid",
  "bin/braid.mjs",
  "manifest.json",
];
const tarString = (buffer) => {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul < 0 ? buffer.length : nul).toString("utf8");
};
const tarNumber = (buffer, label) => {
  const value = tarString(buffer).trim();
  if (!/^[0-7]*$/.test(value)) fail(`archive has invalid ${label}`);
  return value === "" ? 0 : Number.parseInt(value, 8);
};
const inspectArchive = async (archive) => {
  let bytes;
  try {
    bytes = gunzipSync(await readFile(archive));
  } catch (error) {
    fail(`archive is not a valid gzip stream: ${error.message}`);
  }
  const seen = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = tarNumber(header.subarray(148, 156), "header checksum");
    let sum = 0;
    for (let index = 0; index < 512; index += 1)
      sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== storedChecksum) fail("archive header checksum is invalid");
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const entry = prefix ? `${prefix}/${name}` : name;
    if (!entry || entry.startsWith("/") || entry.includes("\\"))
      fail(`archive contains an invalid absolute or non-POSIX path: ${entry}`);
    const parts = entry.split("/").filter((part) => part !== "");
    if (parts.some((part) => part === "." || part === ".."))
      fail(`archive path traversal rejected: ${entry}`);
    if (parts[0] !== artifactName)
      fail(`archive has unexpected top-level structure: ${entry}`);
    const typeByte = header[156];
    const type = typeByte === 0 || typeByte === 48 ? "file" : typeByte === 53 ? "directory" : typeByte === 50 ? "symlink" : undefined;
    if (!type) fail(`archive contains an unsupported device, FIFO, socket, hard link, or metadata entry: ${entry}`);
    if (seen.has(entry)) fail(`archive contains duplicate path: ${entry}`);
    seen.set(entry, type);
    if (type === "symlink") {
      const target = tarString(header.subarray(157, 257));
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), target));
      if (!target || target.startsWith("/") || (resolved !== artifactName && !resolved.startsWith(`${artifactName}/`)))
        fail(`archive symlink escapes the package root: ${entry} -> ${target}`);
    }
    const size = tarNumber(header.subarray(124, 136), "entry size");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > bytes.length) fail(`archive entry is truncated: ${entry}`);
  }
  if (seen.size === 0) fail("archive is empty");
};

const assertSafeRelative = (relative, label) => {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(`${label} contains an unsafe path: ${relative}`);
};
const validateDistribution = async (directory, version, runSmoke = true) => {
  for (const relative of requiredDistributionFiles) {
    const metadata = await exists(path.join(directory, relative));
    if (!metadata?.isFile()) fail(`distribution is missing required file: ${relative}`);
  }
  let distributionManifest;
  try {
    distributionManifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    fail(`distribution manifest is invalid: ${error.message}`);
  }
  if (
    distributionManifest.schemaVersion !== "1.0.0" ||
    distributionManifest.name !== `braid-v${version}-demo-node22` ||
    distributionManifest.braidVersion !== version ||
    !Array.isArray(distributionManifest.files)
  )
    fail("distribution manifest identity does not match the selected release");
  const manifestPaths = new Set();
  for (const file of distributionManifest.files) {
    assertSafeRelative(file?.path, "distribution manifest");
    if (manifestPaths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size))
      fail(`invalid distribution manifest entry: ${file?.path}`);
    manifestPaths.add(file.path);
    const absolute = path.join(directory, ...file.path.split("/"));
    const metadata = await exists(absolute);
    if (!metadata?.isFile() || metadata.isSymbolicLink())
      fail(`distribution manifest file is missing or not regular: ${file.path}`);
    const contents = await readFile(absolute);
    if (contents.length !== file.size || createHash("sha256").update(contents).digest("hex") !== file.sha256)
      fail(`distribution manifest checksum mismatch: ${file.path}`);
  }
  for (const required of requiredDistributionFiles.filter(
    (file) => file !== "manifest.json" && file !== "SHA256SUMS",
  ))
    if (!manifestPaths.has(required)) fail(`distribution manifest omits required file: ${required}`);
  const actualFiles = [];
  const walk = async (current, prefix = "") => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) actualFiles.push(relative);
      else fail(`distribution contains unsupported path: ${relative}`);
    }
  };
  await walk(directory);
  const expectedFiles = new Set([
    ...manifestPaths,
    "manifest.json",
    "SHA256SUMS",
  ]);
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((relative) => !expectedFiles.has(relative))
  )
    fail("distribution files do not exactly match its manifest");
  if (runSmoke) {
    const launcher = path.join(directory, "bin", "braid");
    let reported;
    let helpOutput;
    try {
      reported = await execFile(launcher, ["--version"], { encoding: "utf8", timeout: 60_000 });
      helpOutput = await execFile(launcher, ["--help"], { encoding: "utf8", timeout: 60_000 });
    } catch (error) {
      fail(`staged smoke test failed: ${error.message}`);
    }
    if (reported.stdout.trim() !== version)
      fail(`staged CLI reported ${reported.stdout.trim() || "empty output"}; expected ${version}`);
    if (!helpOutput.stdout.trim()) fail("staged CLI help output is empty");
  }
  return distributionManifest;
};

let temporary;
let stagingDirectory;
let createdVersion = false;
let pathChange;
const cleanup = async () => {
  if (stagingDirectory) await safeRemoveStaging(stagingDirectory).catch(() => {});
  if (temporary && !options.keepDownloads) await rm(temporary, { recursive: true, force: true });
};
const safeRemoveStaging = async (target) => {
  if (
    !target ||
    path.dirname(target) !== versionsRoot ||
    !path.basename(target).startsWith(`.${selectedVersion}.tmp-`)
  )
    fail(`refusing unsafe staging removal: ${target}`);
  await rm(target, { recursive: true, force: true });
};
const safeRemoveVersion = async (target) => {
  if (
    !target ||
    path.dirname(target) !== versionsRoot ||
    path.basename(target) !== selectedVersion ||
    target === installRoot ||
    target === binDirectory ||
    target === home
  )
    fail(`refusing unsafe version removal: ${target}`);
  if (path.dirname(await realpath(target)) !== versionsRoot)
    fail(`refusing version removal outside the canonical versions root: ${target}`);
  await rm(target, { recursive: true, force: true });
};
let signalHandling = false;
const handleSignal = async (signal, exitCode) => {
  if (signalHandling) return;
  signalHandling = true;
  await cleanup();
  process.stderr.write(`braid installer: interrupted by ${signal}; temporary resources cleaned.\n`);
  process.exit(exitCode);
};
process.once("SIGINT", () => void handleSignal("SIGINT", 130));
process.once("SIGTERM", () => void handleSignal("SIGTERM", 143));

const pathInEnvironment = env.PATH?.split(path.delimiter).includes(binDirectory) ?? false;
const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const pathLine =
  binDirectory === path.join(home, ".local", "bin")
    ? 'export PATH="$HOME/.local/bin:$PATH"'
    : `export PATH=${shellQuote(binDirectory)}:"$PATH"`;
const countText = (contents, needle) => contents.split(needle).length - 1;
const planPath = async () => {
  if (options.noPathUpdate || (pathInEnvironment && !options.forcePathUpdate))
    return { changed: false, pathFile: null, blockInstalled: false };
  const shell = path.basename(env.SHELL ?? "");
  if (!new Set(["zsh", "bash"]).has(shell)) {
    process.stderr.write(`braid installer: shell '${shell || "unknown"}' is not supported for automatic PATH updates; no shell file was changed.\n`);
    return { changed: false, pathFile: null, blockInstalled: false };
  }
  const pathFile = path.join(
    home,
    shell === "zsh"
      ? ".zshrc"
      : process.platform === "darwin"
        ? ".bash_profile"
        : ".bashrc",
  );
  const metadata = await exists(pathFile);
  if (metadata && (!metadata.isFile() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())))
    fail(`shell startup file is not a user-owned regular file: ${pathFile}`);
  const before = metadata ? await readFile(pathFile, "utf8") : "";
  const starts = countText(before, markerStart);
  const ends = countText(before, markerEnd);
  if (starts > 1 || ends > 1 || starts !== ends)
    fail(`ambiguous Braid PATH ownership blocks in ${pathFile}`);
  const block = `${markerStart}\n${pathLine}\n${markerEnd}`;
  let after;
  if (starts === 1) {
    const start = before.indexOf(markerStart);
    const end = before.indexOf(markerEnd, start);
    const afterEnd = end + markerEnd.length;
    if (
      end < start ||
      (start > 0 && before[start - 1] !== "\n") ||
      (afterEnd < before.length && before[afterEnd] !== "\n")
    )
      fail(`ambiguous Braid PATH ownership block in ${pathFile}`);
    after = `${before.slice(0, start)}${block}${before.slice(end + markerEnd.length)}`;
  } else {
    const separator = before === "" || before.endsWith("\n") ? "" : "\n";
    const suffix = before === "" || before.endsWith("\n") ? "\n" : "";
    after = `${before}${separator}${block}${suffix}`;
  }
  return {
    changed: after !== before,
    pathFile,
    blockInstalled: true,
    before,
    after,
    mode: metadata ? metadata.mode & 0o777 : 0o600,
    existed: Boolean(metadata),
  };
};
const applyPath = async (change) => {
  if (!change?.changed) return;
  if (change.existed) {
    change.backup = `${change.pathFile}.braid-backup-${createHash("sha256").update(change.before).digest("hex")}`;
    if (!(await exists(change.backup))) {
      await copyFile(change.pathFile, change.backup, fsConstants.COPYFILE_EXCL);
      change.backupCreated = true;
    }
  }
  change.applied = true;
  await atomicWrite(change.pathFile, change.after, change.mode);
};
const rollbackPath = async (change) => {
  if (!change?.applied) return;
  if (change.existed) await atomicWrite(change.pathFile, change.before);
  else await rm(change.pathFile, { force: true });
  if (change.backupCreated) await rm(change.backup, { force: true });
};
const restoreLink = async (link, oldTarget) => {
  if (oldTarget === undefined) await rm(link, { force: true });
  else await atomicSymlink(link, oldTarget);
};

try {
  const versionDirectory = path.join(versionsRoot, selectedVersion);
  let installedValid = false;
  if (await exists(versionDirectory)) {
    if (
      !oldManifest?.installedVersions.some(
        (entry) => entry.version === selectedVersion,
      )
    )
      fail(`existing version directory lacks installer ownership: ${versionDirectory}`);
    const metadata = await exists(versionDirectory);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink())
      fail(`existing version path is not an owned directory: ${versionDirectory}`);
    if (path.dirname(await realpath(versionDirectory)) !== versionsRoot)
      fail(`existing version escapes the canonical versions directory: ${versionDirectory}`);
    await validateDistribution(versionDirectory, selectedVersion);
    installedValid = true;
  }

  let archiveSha256 = oldManifest?.installedVersions.find(
    (entry) => entry.version === selectedVersion && /^[a-f0-9]{64}$/.test(entry.archiveSha256),
  )?.archiveSha256;
  const sameVersion =
    installedValid &&
    (activeBefore?.version === selectedVersion ||
      (!activeBefore && oldManifest?.activeVersion === selectedVersion));
  if (
    oldManifest &&
    !activeBefore &&
    oldManifest.activeVersion !== selectedVersion
  )
    fail("current link is missing and cannot be repaired while changing versions");
  if (!sameVersion) {
    temporary = await mkdtemp(path.join(os.tmpdir(), "braid-install-"));
    await chmod(temporary, 0o700);
    const tempMetadata = await stat(temporary);
    if (typeof process.getuid === "function" && tempMetadata.uid !== process.getuid())
      fail(`temporary workspace is not owned by the current user: ${temporary}`);
    const archive = path.join(temporary, archiveName);
    const checksums = path.join(temporary, "SHA256SUMS");
    await download(checksumUrl, checksums, "checksum download");
    archiveSha256 = parseChecksums(await readFile(checksums, "utf8"));
    if (!installedValid) {
      await download(archiveUrl, archive, "archive download");
      const actual = await digestFile(archive);
      if (actual !== archiveSha256)
        fail(`archive checksum mismatch: expected ${archiveSha256}, received ${actual}`);
      await inspectArchive(archive);
      const extraction = path.join(temporary, "extracted");
      await mkdir(extraction, { mode: 0o700 });
      try {
        await execFile("tar", ["-xzf", archive, "-C", extraction, "--no-same-owner"], {
          timeout: 60_000,
        });
      } catch (error) {
        fail(`archive extraction failed: ${error.message}`);
      }
      const extractedDistribution = path.join(extraction, artifactName);
      await validateDistribution(extractedDistribution, selectedVersion, false);
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      await verifyVersionsRoot(true);
      const rootMetadata = await stat(installRoot);
      const versionsMetadata = await stat(versionsRoot);
      if (
        (typeof process.getuid === "function" &&
          (rootMetadata.uid !== process.getuid() || versionsMetadata.uid !== process.getuid())) ||
        !rootMetadata.isDirectory() ||
        !versionsMetadata.isDirectory()
      )
        fail("installation directories are not owned directories");
      stagingDirectory = path.join(
        versionsRoot,
        `.${selectedVersion}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`,
      );
      await cp(extractedDistribution, stagingDirectory, { recursive: true, errorOnExist: true });
      await validateDistribution(stagingDirectory, selectedVersion);
      await rename(stagingDirectory, versionDirectory);
      stagingDirectory = undefined;
      createdVersion = true;
    }
  }
  if (!archiveSha256) {
    temporary = await mkdtemp(path.join(os.tmpdir(), "braid-install-"));
    await chmod(temporary, 0o700);
    const checksums = path.join(temporary, "SHA256SUMS");
    await download(checksumUrl, checksums, "checksum download");
    archiveSha256 = parseChecksums(await readFile(checksums, "utf8"));
  }

  let activationAttempted = false;
  try {
    activationAttempted = true;
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    await binaryState();
    const oldInstalled = oldManifest?.installedVersions ?? [];
    const installedAt =
      oldInstalled.find((entry) => entry.version === selectedVersion)?.installedAt ??
      new Date().toISOString();
    const installedVersions = [
      ...oldInstalled.filter((entry) => entry.version !== selectedVersion),
      { version: selectedVersion, archiveName, archiveSha256, installedAt },
    ].sort((left, right) => compareVersions(left.version, right.version));

    if (!sameVersion || !activeBefore) {
      if (activeBefore && activeBefore.version !== selectedVersion)
        await atomicSymlink(previousLink, path.join("versions", activeBefore.version));
      await atomicSymlink(currentLink, path.join("versions", selectedVersion));
    }
    if (!binaryBefore) await atomicSymlink(binaryLink, expectedBinaryTarget);
    pathChange = await planPath();
    const previousNow = await linkTargetWithinVersions(previousLink);
    const ownershipManifest = {
      schemaVersion: 1,
      installMethod: "release-script",
      repository: options.repository,
      activeVersion: selectedVersion,
      previousVersion: previousNow?.version ?? null,
      installRoot,
      binDirectory,
      binaryLink,
      pathFile:
        pathChange.pathFile ?? (oldManifest?.pathBlockInstalled ? oldManifest.pathFile : null),
      pathBlockInstalled:
        pathChange.blockInstalled || Boolean(oldManifest?.pathBlockInstalled),
      installedVersions,
    };
    await atomicWrite(manifestPath, `${JSON.stringify(ownershipManifest, null, 2)}\n`);
    await applyPath(pathChange);

    const versionOutput = await execFile(binaryLink, ["--version"], { encoding: "utf8", timeout: 60_000 });
    const helpOutput = await execFile(binaryLink, ["--help"], { encoding: "utf8", timeout: 60_000 });
    if (versionOutput.stdout.trim() !== selectedVersion || !helpOutput.stdout.trim())
      fail("post-activation smoke output did not match the selected version");
  } catch (error) {
    const rollbackErrors = [];
    const rollback = async (operation) => {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    };
    if (activationAttempted) {
      await rollback(() => rollbackPath(pathChange));
      await rollback(() => restoreLink(currentLink, activeBefore?.raw));
      await rollback(() => restoreLink(previousLink, previousBefore?.raw));
      await rollback(() => restoreLink(binaryLink, binaryBefore));
      await rollback(() =>
        oldManifestText !== undefined
          ? atomicWrite(manifestPath, oldManifestText)
          : rm(manifestPath, { force: true }),
      );
    }
    if (createdVersion) await rollback(() => safeRemoveVersion(versionDirectory));
    fail(
      `${error.message}; ${
        rollbackErrors.length === 0
          ? "previous installation restored"
          : `rollback incomplete: ${rollbackErrors.join("; ")}`
      }`,
    );
  }

  const relation = activeBefore ? compareVersions(selectedVersion, activeBefore.version) : 0;
  const status = sameVersion
    ? binaryBefore && oldManifest && activeBefore
      ? "already installed"
      : "repaired"
    : !activeBefore
      ? "installed"
      : relation < 0
        ? "downgraded"
        : "upgraded";
  process.stdout.write(`Braid ${selectedVersion} ${status}.\nActive: ${binaryLink}\n`);
  if (!pathInEnvironment) {
    process.stdout.write(`Restart your shell, or run:\n${pathLine}\n`);
  }
  if (options.keepDownloads && temporary)
    process.stdout.write(`Downloads kept at: ${temporary}\n`);
} finally {
  await cleanup();
}
BRAID_INSTALLER_NODE
