#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "braid uninstaller: Node.js 22 or newer is required to validate installer ownership." >&2
  exit 1
fi
node_version=$(node --version 2>/dev/null || true)
node_major=$(printf '%s\n' "$node_version" | sed 's/^v//' | cut -d. -f1)
case $node_major in
  ''|*[!0-9]*|0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21)
    echo "braid uninstaller: detected Node.js $node_version; Node.js 22 or newer is required to validate installer ownership." >&2
    exit 1
    ;;
esac

node --input-type=module - "$@" <<'BRAID_UNINSTALLER_NODE'
import { createHash, randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const markerStart = "# >>> braid installer >>>";
const markerEnd = "# <<< braid installer <<<";
const fail = (message) => {
  throw new Error(message);
};
process.on("uncaughtException", (error) => {
  process.stderr.write(`braid uninstaller: ${error.message}\n`);
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
  installDir:
    env.BRAID_INSTALL_DIR ??
    path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "share"), "braid"),
  binDir: env.BRAID_BIN_DIR,
  explicitBinDir: Object.hasOwn(env, "BRAID_BIN_DIR"),
  keepVersions: false,
  keepPath: false,
  dryRun: false,
};
const valueAfter = (index, flag) => {
  if (index + 1 >= args.length) fail(`${flag} requires a value`);
  return rejectMalformed(args[index + 1], flag);
};
let help = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = rejectMalformed(args[index], "argument");
  switch (argument) {
    case "--install-dir":
      options.installDir = valueAfter(index, argument);
      index += 1;
      break;
    case "--bin-dir":
      options.binDir = valueAfter(index, argument);
      options.explicitBinDir = true;
      index += 1;
      break;
    case "--keep-versions":
      options.keepVersions = true;
      break;
    case "--keep-path":
      options.keepPath = true;
      break;
    case "--dry-run":
      options.dryRun = true;
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
  process.stdout.write(`Uninstall resources owned by the Braid release installer.

Usage: uninstall.sh [options]

  --install-dir <path>  Installation root
  --bin-dir <path>      Binary link directory
  --keep-versions       Preserve installed version directories
  --keep-path           Preserve the installer-owned PATH block
  --dry-run             Validate and show the plan without mutation
  --help
`);
  process.exit(0);
}

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
  return path.join(await realpath(ancestor), ...tail);
};
const installRoot = await canonicalFuture(options.installDir, "install directory");
if (installRoot === path.parse(installRoot).root || installRoot === home)
  fail("install directory must not be / or HOME");
const manifestPath = path.join(installRoot, "install-manifest.json");
const manifestMetadata = await exists(manifestPath);
const growthNotice = () =>
  process.stdout.write(
    "Repository-local Growth Mode hooks are not removed automatically.\n" +
      "Run `braid growth uninstall codex` inside each affected repository before\n" +
      "uninstalling Braid when desired.\n",
  );
if (!manifestMetadata) {
  process.stdout.write("Braid release-script installation is already absent; nothing was removed.\n");
  growthNotice();
  process.exit(0);
}
if (
  !manifestMetadata.isFile() ||
  manifestMetadata.isSymbolicLink() ||
  (typeof process.getuid === "function" && manifestMetadata.uid !== process.getuid())
)
  fail(`installer manifest is not an owned regular file: ${manifestPath}`);
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  fail(`installer manifest is invalid: ${error.message}`);
}
if (
  manifest.schemaVersion !== 1 ||
  manifest.installMethod !== "release-script" ||
  manifest.installRoot !== installRoot ||
  typeof manifest.binDirectory !== "string" ||
  typeof manifest.binaryLink !== "string" ||
  !Array.isArray(manifest.installedVersions)
)
  fail(`installer manifest ownership does not match ${installRoot}`);

const binDirectory = await canonicalFuture(
  options.explicitBinDir ? options.binDir : manifest.binDirectory,
  "bin directory",
);
if (
  binDirectory === path.parse(binDirectory).root ||
  manifest.binDirectory !== binDirectory ||
  manifest.binaryLink !== path.join(binDirectory, "braid")
)
  fail("bin directory does not match installer ownership");
if (binDirectory === installRoot || binDirectory.startsWith(`${installRoot}${path.sep}`))
  fail("invalid manifest: bin directory is inside the installation root");

const versionsRoot = path.join(installRoot, "versions");
const currentLink = path.join(installRoot, "current");
const previousLink = path.join(installRoot, "previous");
const binaryLink = manifest.binaryLink;
const expectedBinary = path.join(installRoot, "current", "bin", "braid");
const versionsMetadata = await exists(versionsRoot);
if (
  !versionsMetadata ||
  !versionsMetadata.isDirectory() ||
  versionsMetadata.isSymbolicLink() ||
  (typeof process.getuid === "function" &&
    versionsMetadata.uid !== process.getuid()) ||
  (await realpath(versionsRoot)) !== versionsRoot
)
  fail(`versions directory is not a canonical user-owned directory: ${versionsRoot}`);
const installedVersionNames = new Set();
for (const entry of manifest.installedVersions) {
  if (!entry || !/^\d+\.\d+\.\d+$/.test(entry.version) || installedVersionNames.has(entry.version))
    fail("installer manifest contains an invalid or duplicate installed version");
  installedVersionNames.add(entry.version);
}
if (!installedVersionNames.has(manifest.activeVersion))
  fail("installer manifest activeVersion is not owned");
if (manifest.previousVersion !== null && !installedVersionNames.has(manifest.previousVersion))
  fail("installer manifest previousVersion is not owned");

const validateOwnedLink = async (link, expectedVersion) => {
  const metadata = await exists(link);
  if (!metadata) {
    if (expectedVersion) fail(`owned link is missing: ${link}`);
    return undefined;
  }
  if (!metadata.isSymbolicLink()) fail(`ownership mismatch: ${link} is not a symlink`);
  const raw = await readlink(link);
  const resolved = path.resolve(path.dirname(link), raw);
  if (
    path.dirname(resolved) !== versionsRoot ||
    !installedVersionNames.has(path.basename(resolved)) ||
    (expectedVersion && path.basename(resolved) !== expectedVersion)
  )
    fail(`ownership mismatch: ${link} -> ${raw}`);
  return raw;
};
await validateOwnedLink(currentLink, manifest.activeVersion);
if (manifest.previousVersion === null) {
  if (await exists(previousLink))
    fail("ownership mismatch: previous link exists but the manifest records no previous version");
} else {
  await validateOwnedLink(previousLink, manifest.previousVersion);
}

const binaryMetadata = await exists(binaryLink);
if (binaryMetadata) {
  if (!binaryMetadata.isSymbolicLink())
    fail(`ownership mismatch at ${binaryLink}; the unknown binary was preserved.`);
  const target = await readlink(binaryLink);
  if (path.resolve(binDirectory, target) !== expectedBinary)
    fail(`ownership mismatch at ${binaryLink}; the unknown symlink was preserved.`);
}

const assertSafeRelative = (relative) => {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(`distribution manifest contains unsafe path: ${relative}`);
};
const walkFiles = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else fail(`owned version contains an unsupported path: ${relative}`);
  }
  return files.sort();
};
const validateOwnedVersion = async (version) => {
  const directory = path.join(versionsRoot, version);
  const metadata = await exists(directory);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    fail(`owned version path is not a directory: ${directory}`);
  if (path.dirname(await realpath(directory)) !== versionsRoot)
    fail(`owned version escapes the canonical versions directory: ${directory}`);
  let distributionManifest;
  try {
    distributionManifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    fail(`owned version ${version} has an invalid distribution manifest: ${error.message}`);
  }
  if (
    distributionManifest.schemaVersion !== "1.0.0" ||
    distributionManifest.braidVersion !== version ||
    !Array.isArray(distributionManifest.files)
  )
    fail(`owned version ${version} identity does not match`);
  const expected = new Set(["manifest.json", "SHA256SUMS"]);
  for (const file of distributionManifest.files) {
    assertSafeRelative(file?.path);
    if (expected.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size))
      fail(`owned version ${version} has an invalid file entry`);
    expected.add(file.path);
    const absolute = path.join(directory, ...file.path.split("/"));
    const fileMetadata = await exists(absolute);
    if (!fileMetadata?.isFile() || fileMetadata.isSymbolicLink())
      fail(`owned version file is missing or changed: ${file.path}`);
    const contents = await readFile(absolute);
    if (
      contents.length !== file.size ||
      createHash("sha256").update(contents).digest("hex") !== file.sha256
    )
      fail(`owned version file checksum mismatch: ${file.path}`);
  }
  const actual = await walkFiles(directory);
  if (
    actual.length !== expected.size ||
    actual.some((relative) => !expected.has(relative))
  )
    fail(`owned version ${version} contains unknown data and was preserved`);
};
if (!options.keepVersions)
  for (const version of installedVersionNames) await validateOwnedVersion(version);

let pathPlan;
if (!options.keepPath && manifest.pathBlockInstalled) {
  if (typeof manifest.pathFile !== "string") fail("manifest PATH ownership is incomplete");
  const pathFile = await canonicalFuture(manifest.pathFile, "PATH file");
  if (
    path.dirname(pathFile) !== home ||
    !new Set([".zshrc", ".bashrc", ".bash_profile"]).has(
      path.basename(pathFile),
    )
  )
    fail(`PATH file is outside the supported user-owned shell files: ${pathFile}`);
  const metadata = await exists(pathFile);
  if (metadata) {
    if (!metadata.isFile() || metadata.isSymbolicLink() || (typeof process.getuid === "function" && metadata.uid !== process.getuid()))
      fail(`PATH file is not an owned regular file: ${pathFile}`);
    const before = await readFile(pathFile, "utf8");
    const starts = before.split(markerStart).length - 1;
    const ends = before.split(markerEnd).length - 1;
    if (starts > 1 || ends > 1 || starts !== ends)
      fail(`ambiguous Braid PATH ownership blocks in ${pathFile}`);
    if (starts === 1) {
      const start = before.indexOf(markerStart);
      const markerEndIndex = before.indexOf(markerEnd, start);
      const end = markerEndIndex + markerEnd.length;
      if (
        markerEndIndex < start ||
        (start > 0 && before[start - 1] !== "\n") ||
        (end < before.length && before[end] !== "\n")
      )
        fail(`ambiguous Braid PATH ownership block in ${pathFile}`);
      const removeEnd = before[end] === "\n" ? end + 1 : end;
      const removeStart =
        end === before.length && start > 0 && before[start - 1] === "\n"
          ? start - 1
          : start;
      pathPlan = {
        file: pathFile,
        before,
        after: `${before.slice(0, removeStart)}${before.slice(removeEnd)}`,
        mode: metadata.mode & 0o777,
      };
    }
  }
}

if (options.dryRun) {
  process.stdout.write(`Braid uninstaller dry run
Install root: ${installRoot}
Binary link: ${binaryLink}
Versions: ${options.keepVersions ? "preserved" : [...installedVersionNames].join(", ")}
PATH block: ${options.keepPath ? "preserved" : "removed when present"}
No files were changed.
`);
  growthNotice();
  process.exit(0);
}

const atomicWrite = async (file, contents, mode) => {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
if (binaryMetadata) await rm(binaryLink);
if (pathPlan && pathPlan.after !== pathPlan.before) {
  const backup = `${pathPlan.file}.braid-backup-${createHash("sha256").update(pathPlan.before).digest("hex")}`;
  if (!(await exists(backup))) await copyFile(pathPlan.file, backup, fsConstants.COPYFILE_EXCL);
  await atomicWrite(pathPlan.file, pathPlan.after, pathPlan.mode);
}
if (!options.keepVersions) {
  for (const version of installedVersionNames) {
    const directory = path.join(versionsRoot, version);
    if (await exists(directory)) {
      if (
        path.dirname(directory) !== versionsRoot ||
        directory === installRoot ||
        directory === home ||
        directory === binDirectory
      )
        fail(`refusing unsafe recursive removal: ${directory}`);
      await rm(directory, { recursive: true });
    }
  }
}
if (await exists(currentLink)) await rm(currentLink);
if (await exists(previousLink)) await rm(previousLink);
await rm(manifestPath);
for (const directory of [versionsRoot, installRoot]) {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

process.stdout.write("Braid release-script installation was removed.\n");
if (options.keepVersions) process.stdout.write(`Version directories were preserved under ${versionsRoot}.\n`);
if (options.keepPath) process.stdout.write("The installer-owned PATH block was preserved.\n");
growthNotice();
BRAID_UNINSTALLER_NODE
