import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { gzipSync } from "node:zlib";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installScript = path.join(repository, "install.sh");
const uninstallScript = path.join(repository, "uninstall.sh");
const packageJson = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
const version = packageJson.version;
const artifactName = `braid-v${version}-demo-node22`;
const sourceDistribution = path.join(repository, ".artifacts", artifactName);
const sourceArchive = path.join(
  repository,
  ".artifacts",
  `${artifactName}.tar.gz`,
);
const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const run = (command, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out: ${command} ${arguments_.join(" ")}`));
    }, options.timeout ?? 60_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      const expected = options.expectedCode ?? 0;
      if (code !== expected && !(expected === "nonzero" && code !== 0)) {
        reject(
          new Error(
            `${command} ${arguments_.join(" ")} exited ${code ?? signal}\n` +
              `${result.stdout}${result.stderr}`,
          ),
        );
      } else resolve(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });

const waitFor = async (predicate, label, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const walkRegularFiles = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await walkRegularFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
};

const octal = (buffer, offset, length, value) => {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buffer.write(encoded, offset, length, "ascii");
};

const tar = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(header, 100, 8, entry.mode ?? 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, body.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), {
    mtime: 0,
  });
};

const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "braid-install-tests-"));
const fixturesRoot = path.join(suiteRoot, "fixtures");
await mkdir(fixturesRoot);

const robustLauncher = (
  reportedVersion,
  postActivationFailure = false,
) => `#!/usr/bin/env sh
set -eu
script=$0
while [ -L "$script" ]; do
  target=$(readlink "$script")
  case $target in /*) script=$target ;; *) script=$(dirname "$script")/$target ;; esac
done
directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd)
${postActivationFailure ? `case $directory in */versions/${reportedVersion}/bin) [ "\${1-}" != "--help" ] || exit 97 ;; esac` : ""}
case \${1-} in
  --version) printf '%s\\n' '${reportedVersion}' ;;
  *) exec node "$directory/braid.mjs" "$@" ;;
esac
`;

const makeRelease = async (
  releaseVersion,
  {
    reportedVersion = releaseVersion,
    missing,
    escapingSymlink,
    postActivationFailure,
  } = {},
) => {
  const work = path.join(
    fixturesRoot,
    `${releaseVersion}-${sha256(JSON.stringify({ reportedVersion, missing, escapingSymlink, postActivationFailure })).slice(0, 10)}`,
  );
  const top = `braid-v${releaseVersion}-demo-node22`;
  const distribution = path.join(work, top);
  await mkdir(work, { recursive: true });
  await cp(sourceDistribution, distribution, { recursive: true });
  await writeFile(
    path.join(distribution, "bin", "braid"),
    robustLauncher(reportedVersion, postActivationFailure),
    { mode: 0o755 },
  );
  if (missing) await rm(path.join(distribution, missing), { force: true });

  const manifestPath = path.join(distribution, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = top;
  manifest.braidVersion = releaseVersion;
  const payload = (await walkRegularFiles(distribution)).filter(
    (file) => file !== "manifest.json" && file !== "SHA256SUMS",
  );
  manifest.files = await Promise.all(
    payload.map(async (file) => {
      const contents = await readFile(path.join(distribution, file));
      return { path: file, sha256: sha256(contents), size: contents.length };
    }),
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumFiles = (await walkRegularFiles(distribution)).filter(
    (file) => file !== "SHA256SUMS",
  );
  await writeFile(
    path.join(distribution, "SHA256SUMS"),
    `${(
      await Promise.all(
        checksumFiles.map(async (file) => {
          const contents = await readFile(path.join(distribution, file));
          return `${sha256(contents)}  ${file}`;
        }),
      )
    ).join("\n")}\n`,
  );
  if (escapingSymlink)
    await symlink("../../outside", path.join(distribution, "escape"));

  const archiveName = `${top}.tar.gz`;
  const archivePath = path.join(work, archiveName);
  await run(
    "tar",
    ["--format=ustar", "--no-xattrs", "-czf", archivePath, "-C", work, top],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  const archive = await readFile(archivePath);
  return {
    version: releaseVersion,
    archiveName,
    archive,
    checksum: `${sha256(archive)}  ${archiveName}\n`,
  };
};

await Promise.all([
  access(installScript),
  access(uninstallScript),
  access(sourceDistribution),
  access(sourceArchive),
]);
assert(
  version === "0.6.0",
  `Installer suite requires v0.6.0, found ${version}`,
);

const releases = new Map();
const builtArchive = await readFile(sourceArchive);
releases.set("0.6.0", {
  version: "0.6.0",
  archiveName: `${artifactName}.tar.gz`,
  archive: builtArchive,
  checksum: `${sha256(builtArchive)}  ${artifactName}.tar.gz\n`,
});
releases.set("0.5.0", await makeRelease("0.5.0"));
const wrongVersionRelease = await makeRelease("0.6.0", {
  reportedVersion: "9.9.9",
});
const missingLauncherRelease = await makeRelease("0.6.0", {
  missing: "bin/braid",
});
const escapingSymlinkRelease = await makeRelease("0.6.0", {
  escapingSymlink: true,
});
const postActivationFailureRelease = await makeRelease("0.6.0", {
  postActivationFailure: true,
});

const releaseState = {
  latest: "0.6.0",
  api: "ok",
  prerelease: false,
  draft: false,
  releaseOverrides: new Map(),
  checksumOverrides: new Map(),
  interrupted: new Set(),
  slow: new Set(),
  missingAssets: new Set(),
  requests: [],
};

const resetServer = () => {
  releaseState.latest = "0.6.0";
  releaseState.api = "ok";
  releaseState.prerelease = false;
  releaseState.draft = false;
  releaseState.releaseOverrides.clear();
  releaseState.checksumOverrides.clear();
  releaseState.interrupted.clear();
  releaseState.slow.clear();
  releaseState.missingAssets.clear();
  releaseState.requests.length = 0;
};

let serverBase;
const heldResponses = new Set();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, serverBase);
  releaseState.requests.push(url.pathname);
  if (url.pathname === "/install.sh") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(await readFile(installScript));
    return;
  }
  const latestMatch = url.pathname === "/repos/ting10688/Braid/releases/latest";
  const tagMatch = /^\/repos\/ting10688\/Braid\/releases\/tags\/v([^/]+)$/.exec(
    url.pathname,
  );
  if (latestMatch || tagMatch) {
    if (releaseState.api === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
      return;
    }
    const selected = latestMatch ? releaseState.latest : tagMatch[1];
    const release =
      releaseState.releaseOverrides.get(selected) ?? releases.get(selected);
    if (!release || releaseState.api === "404") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const assets = releaseState.missingAssets.has("archive")
      ? ["SHA256SUMS"]
      : releaseState.missingAssets.has("checksum")
        ? [release.archiveName]
        : [release.archiveName, "SHA256SUMS"];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        tag_name: `v${selected}`,
        draft: releaseState.draft,
        prerelease: releaseState.prerelease,
        assets: assets.map((name) => ({
          name,
          browser_download_url: `${serverBase}/assets/v${selected}/${name}`,
        })),
      }),
    );
    return;
  }
  const assetMatch = /^\/assets\/v([^/]+)\/(.+)$/.exec(url.pathname);
  if (assetMatch) {
    const selected = assetMatch[1];
    const name = decodeURIComponent(assetMatch[2]);
    const release =
      releaseState.releaseOverrides.get(selected) ?? releases.get(selected);
    if (!release) {
      response.writeHead(404);
      response.end();
      return;
    }
    const contents =
      name === "SHA256SUMS"
        ? Buffer.from(
            releaseState.checksumOverrides.get(selected) ?? release.checksum,
          )
        : name === release.archiveName
          ? release.archive
          : undefined;
    if (!contents) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": contents.length,
    });
    if (releaseState.interrupted.has(name)) {
      response.write(contents.subarray(0, Math.floor(contents.length / 2)));
      response.destroy();
    } else if (releaseState.slow.has(name)) {
      heldResponses.add(response);
      response.on("close", () => heldResponses.delete(response));
      response.write(
        contents.subarray(0, Math.min(contents.length, 64 * 1024)),
      );
    } else response.end(contents);
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
serverBase = `http://127.0.0.1:${server.address().port}`;

let homeCounter = 0;
let currentHomes = [];
const makeHome = async (label, spaces = false) => {
  const home = path.join(
    suiteRoot,
    `${spaces ? "home with spaces" : "home"}-${++homeCounter}-${label}`,
  );
  await mkdir(path.join(home, "tmp"), { recursive: true });
  const canonical = await realpath(home);
  currentHomes.push(canonical);
  return canonical;
};

const environment = (home, overrides = {}) => {
  const result = {
    ...process.env,
    HOME: home,
    TMPDIR: path.join(home, "tmp"),
    SHELL: "/bin/zsh",
    BRAID_REPOSITORY: "ting10688/Braid",
    BRAID_DOWNLOAD_BASE_URL: serverBase,
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    PNPM_HOME: "",
    ...overrides,
  };
  for (const key of [
    "XDG_DATA_HOME",
    "XDG_BIN_HOME",
    "BRAID_VERSION",
    "BRAID_INSTALL_DIR",
    "BRAID_BIN_DIR",
  ])
    if (!Object.hasOwn(overrides, key)) delete result[key];
  return result;
};

const install = async (home, arguments_ = [], options = {}) =>
  run("sh", [installScript, ...arguments_], {
    cwd: options.cwd ?? home,
    env: environment(home, options.env),
    expectedCode: options.expectedCode,
  });

const uninstall = async (home, arguments_ = [], options = {}) =>
  run("sh", [uninstallScript, ...arguments_], {
    cwd: options.cwd ?? home,
    env: environment(home, options.env),
    expectedCode: options.expectedCode,
  });

const installRoot = (home) => path.join(home, ".local", "share", "braid");
const binDirectory = (home) => path.join(home, ".local", "bin");
const binary = (home) => path.join(binDirectory(home), "braid");
const manifest = (home, root = installRoot(home)) =>
  readFile(path.join(root, "install-manifest.json"), "utf8").then(JSON.parse);
const reportedVersion = async (home, target = binary(home)) =>
  (
    await run(target, ["--version"], { cwd: home, env: environment(home) })
  ).stdout.trim();
const assertInactive = async (home, root = installRoot(home)) => {
  assert(
    !(await exists(path.join(root, "current"))),
    "failed install activated current",
  );
  assert(!(await exists(binary(home))), "failed install created binary");
};
const count = (input, needle) => input.split(needle).length - 1;

const makeToolWrapper = async (home, name, body) => {
  const directory = path.join(home, "tools");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return directory;
};

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

test("first install through curl pipe and standalone CLI", async () => {
  const home = await makeHome("curl");
  const result = await run(
    "sh",
    ["-c", 'curl -fsSL "$LOCAL_INSTALLER_URL" | sh'],
    {
      cwd: home,
      env: environment(home, {
        LOCAL_INSTALLER_URL: `${serverBase}/install.sh`,
      }),
    },
  );
  assert(await exists(binary(home)), "binary link was not installed");
  assert(
    (await lstat(binary(home))).isSymbolicLink(),
    "binary is not a symlink",
  );
  assert(
    (await reportedVersion(home)) === "0.6.0",
    "installed version is wrong",
  );
  const help = await run(binary(home), ["--help"], {
    cwd: home,
    env: environment(home),
  });
  assert(help.stdout.trim(), "installed help is empty");
  const data = await manifest(home);
  assert(data.schemaVersion === 1, "ownership schema is wrong");
  assert(data.activeVersion === "0.6.0", "manifest active version is wrong");
  assert(
    data.previousVersion === null,
    "first install recorded a previous version",
  );
  assert(!result.stdout.includes("pnpm"), "installer invoked or required pnpm");

  const project = path.join(home, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    '{"name":"clean-install-project","private":true,"type":"module"}\n',
  );
  await writeFile(
    path.join(project, "src", "index.ts"),
    "export const ok = true;\n",
  );
  for (const command of ["init", "analyze", "propose"])
    await run(binary(home), [command], {
      cwd: project,
      env: environment(home, {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        NODE_PATH: "",
      }),
      timeout: 120_000,
    });
});

test("custom roots, spaces, no PATH update, and environment precedence", async () => {
  const home = await makeHome("custom", true);
  const root = path.join(home, "custom install", "braid");
  const bin = path.join(home, "custom bin");
  await install(
    home,
    [
      "--version",
      "v0.6.0",
      "--install-dir",
      root,
      "--bin-dir",
      bin,
      "--no-path-update",
    ],
    {
      env: {
        BRAID_VERSION: "0.5.0",
        BRAID_INSTALL_DIR: path.join(home, "wrong-root"),
        BRAID_BIN_DIR: path.join(home, "wrong-bin"),
      },
    },
  );
  assert(
    (await reportedVersion(home, path.join(bin, "braid"))) === "0.6.0",
    "flag precedence failed",
  );
  assert(await exists(path.join(root, "current")), "custom root was not used");
  assert(
    !(await exists(path.join(home, ".zshrc"))),
    "--no-path-update changed shell files",
  );
});

test("PATH already present is not modified", async () => {
  const home = await makeHome("path-present");
  const shellFile = path.join(home, ".zshrc");
  await writeFile(shellFile, "unchanged\n");
  await install(home, [], {
    env: { PATH: `${binDirectory(home)}:${process.env.PATH}` },
  });
  assert(
    (await readFile(shellFile, "utf8")) === "unchanged\n",
    "existing PATH changed shell file",
  );
});

for (const [shell, file] of [
  ["zsh", ".zshrc"],
  ["bash", process.platform === "darwin" ? ".bash_profile" : ".bashrc"],
])
  test(`${shell} bounded PATH block, backup, and idempotency`, async () => {
    const home = await makeHome(`path-${shell}`);
    const shellFile = path.join(home, file);
    const original = "# user content\nexport USER_VALUE=yes";
    await writeFile(shellFile, original);
    await install(home, [], { env: { SHELL: `/bin/${shell}` } });
    const first = await readFile(shellFile, "utf8");
    assert(
      count(first, "# >>> braid installer >>>") === 1,
      "PATH block count is wrong",
    );
    assert(first.startsWith(original), "unrelated shell prefix changed");
    assert(!first.endsWith("\n"), "shell final-newline behavior changed");
    await install(home, [], { env: { SHELL: `/bin/${shell}` } });
    assert(
      (await readFile(shellFile, "utf8")) === first,
      "reinstall duplicated PATH block",
    );
    const backupContents = [];
    const collect = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (
          entry.isDirectory() &&
          entry.name !== ".local" &&
          entry.name !== "tmp"
        )
          await collect(target);
        else if (target !== shellFile)
          backupContents.push(await readFile(target, "utf8").catch(() => ""));
      }
    };
    await collect(home);
    assert(
      backupContents.includes(original),
      "content-addressed shell backup was not created",
    );
  });

test("existing PATH block updates safely for a quoted custom directory", async () => {
  const home = await makeHome("path-update", true);
  const shellFile = path.join(home, ".zshrc");
  const old =
    '# before\n# >>> braid installer >>>\nexport PATH="/old:$PATH"\n# <<< braid installer <<<\n# after\n';
  await writeFile(shellFile, old);
  const bin = path.join(home, "bin with '$ and spaces");
  await install(home, ["--bin-dir", bin, "--force-path-update"]);
  const updated = await readFile(shellFile, "utf8");
  assert(
    count(updated, "# >>> braid installer >>>") === 1,
    "owned block was duplicated",
  );
  assert(
    updated.startsWith("# before\n") && updated.endsWith("# after\n"),
    "unrelated shell content changed",
  );
  await run(
    "sh",
    [
      "-c",
      '. "$1"; case ":$PATH:" in *":$2:"*) exit 0;; *) exit 1;; esac',
      "sh",
      shellFile,
      bin,
    ],
    {
      env: environment(home),
    },
  );
});

test("ambiguous PATH blocks and dry-run do not mutate", async () => {
  const home = await makeHome("path-ambiguous");
  const shellFile = path.join(home, ".zshrc");
  const block =
    '# >>> braid installer >>>\nexport PATH="/x:$PATH"\n# <<< braid installer <<<\n';
  await writeFile(shellFile, `${block}middle\n${block}`);
  await install(home, [], { expectedCode: "nonzero" });
  assert(
    (await readFile(shellFile, "utf8")) === `${block}middle\n${block}`,
    "ambiguous PATH file changed",
  );

  const dryHome = await makeHome("dry-run");
  await writeFile(path.join(dryHome, ".zshrc"), "keep\n");
  await install(dryHome, ["--dry-run"]);
  assert(!(await exists(installRoot(dryHome))), "dry-run created install root");
  assert(
    (await readFile(path.join(dryHome, ".zshrc"), "utf8")) === "keep\n",
    "dry-run changed PATH file",
  );
});

test("Node and Git minimum versions are enforced before download", async () => {
  for (const [tool, output, expected] of [
    ["node", "v21.9.0", "Node"],
    ["git", "git version 2.38.9", "Git"],
  ]) {
    const home = await makeHome(`old-${tool}`);
    const tools = await makeToolWrapper(
      home,
      tool,
      `printf '%s\\n' '${output}'`,
    );
    const before = releaseState.requests.length;
    const result = await install(home, ["--no-path-update"], {
      env: { PATH: `${tools}:${process.env.PATH}` },
      expectedCode: "nonzero",
    });
    assert(
      `${result.stdout}${result.stderr}`.includes(expected),
      `${tool} error lacks detected requirement`,
    );
    assert(
      releaseState.requests.length === before,
      `${tool} failure downloaded a release`,
    );
    await assertInactive(home);
  }

  const home = await makeHome("minimum-tools");
  const actualNode = process.execPath;
  const gitPath = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  const tools = await makeToolWrapper(
    home,
    "node",
    `if [ "\${1-}" = --version ]; then echo v22.0.0; else exec '${actualNode}' "$@"; fi`,
  );
  await makeToolWrapper(
    home,
    "git",
    `if [ "\${1-}" = --version ]; then echo 'git version 2.39.0'; else exec '${gitPath}' "$@"; fi`,
  );
  await install(home, ["--no-path-update"], {
    env: { PATH: `${tools}:${process.env.PATH}` },
  });
  assert(
    (await reportedVersion(home)) === "0.6.0",
    "minimum tool versions were rejected",
  );
});

const integrityFailure = (name, configure) =>
  test(name, async () => {
    const home = await makeHome(name.replaceAll(" ", "-"));
    await configure();
    await install(home, ["--no-path-update"], { expectedCode: "nonzero" });
    await assertInactive(home);
  });

integrityFailure("wrong archive checksum is rejected", async () => {
  releaseState.checksumOverrides.set(
    "0.6.0",
    `${"0".repeat(64)}  ${releases.get("0.6.0").archiveName}\n`,
  );
});
integrityFailure("missing checksum entry is rejected", async () => {
  releaseState.checksumOverrides.set(
    "0.6.0",
    `${"0".repeat(64)}  other.tar.gz\n`,
  );
});
integrityFailure("conflicting duplicate checksum is rejected", async () => {
  const release = releases.get("0.6.0");
  releaseState.checksumOverrides.set(
    "0.6.0",
    `${release.checksum}${"0".repeat(64)}  ${release.archiveName}\n`,
  );
});
integrityFailure("malformed checksum is rejected", async () => {
  releaseState.checksumOverrides.set("0.6.0", "not-a-checksum\n");
});
integrityFailure("interrupted archive transfer is rejected", async () => {
  releaseState.interrupted.add(releases.get("0.6.0").archiveName);
});
integrityFailure("missing archive asset is rejected", async () => {
  releaseState.missingAssets.add("archive");
});
integrityFailure("missing checksum asset is rejected", async () => {
  releaseState.missingAssets.add("checksum");
});
integrityFailure("missing exact release is rejected", async () => {
  releaseState.api = "404";
});
integrityFailure("malformed release API is rejected", async () => {
  releaseState.api = "malformed";
});
integrityFailure("prerelease is rejected", async () => {
  releaseState.prerelease = true;
});
integrityFailure("draft release is rejected", async () => {
  releaseState.draft = true;
});
integrityFailure("archive with absolute path is rejected", async () => {
  const archive = tar([{ name: "/tmp/braid-escape", body: "unsafe" }]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("archive with parent traversal is rejected", async () => {
  const archive = tar([{ name: "../braid-escape", body: "unsafe" }]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("archive with escaping symlink is rejected", async () => {
  releaseState.releaseOverrides.set("0.6.0", escapingSymlinkRelease);
});
integrityFailure("archive with FIFO is rejected", async () => {
  const archive = tar([{ name: `${artifactName}/pipe`, type: "6" }]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("archive with hard link is rejected", async () => {
  const archive = tar([
    { name: `${artifactName}/first`, body: "data" },
    {
      name: `${artifactName}/second`,
      type: "1",
      link: `${artifactName}/first`,
    },
  ]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("archive with device file is rejected", async () => {
  const archive = tar([{ name: `${artifactName}/device`, type: "3" }]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure(
  "archive with conflicting duplicate path is rejected",
  async () => {
    const duplicate = `${artifactName}/duplicate`;
    const archive = tar([
      { name: duplicate, body: "data" },
      { name: duplicate, type: "5" },
    ]);
    releaseState.releaseOverrides.set("0.6.0", {
      ...releases.get("0.6.0"),
      archive,
      checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
    });
  },
);
integrityFailure("empty archive is rejected", async () => {
  const archive = gzipSync(Buffer.alloc(1024), { mtime: 0 });
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("unexpected archive structure is rejected", async () => {
  const archive = tar([{ name: "unexpected/bin/braid", body: "#!/bin/sh\n" }]);
  releaseState.releaseOverrides.set("0.6.0", {
    ...releases.get("0.6.0"),
    archive,
    checksum: `${sha256(archive)}  ${releases.get("0.6.0").archiveName}\n`,
  });
});
integrityFailure("missing launcher is rejected", async () => {
  releaseState.releaseOverrides.set("0.6.0", missingLauncherRelease);
});
integrityFailure("wrong reported version is rejected", async () => {
  releaseState.releaseOverrides.set("0.6.0", wrongVersionRelease);
});

test("same-version reinstall is idempotent and repairs its binary", async () => {
  const home = await makeHome("reinstall");
  await install(home, ["--no-path-update"]);
  const archivePath = `/assets/v0.6.0/${releases.get("0.6.0").archiveName}`;
  const downloads = () =>
    releaseState.requests.filter((request) => request === archivePath).length;
  const before = downloads();
  const reinstall = await install(home, ["--no-path-update"]);
  assert(downloads() === before, "valid reinstall redownloaded archive");
  assert(
    /already installed|repaired/i.test(
      `${reinstall.stdout}${reinstall.stderr}`,
    ),
    "reinstall status is unclear",
  );
  await rm(binary(home));
  await install(home, ["--no-path-update"]);
  assert(downloads() === before, "binary repair redownloaded archive");
  assert(
    (await reportedVersion(home)) === "0.6.0",
    "repaired binary does not work",
  );
});

test("upgrade, previous link, and explicit downgrade", async () => {
  const home = await makeHome("upgrade-downgrade");
  await install(home, ["--version", "0.5.0", "--no-path-update"]);
  assert(
    (await reportedVersion(home)) === "0.5.0",
    "synthetic previous release failed",
  );
  await install(home, ["--no-path-update"]);
  assert((await reportedVersion(home)) === "0.6.0", "upgrade failed");
  assert(
    (await readlink(path.join(installRoot(home), "previous"))).endsWith(
      "versions/0.5.0",
    ),
    "upgrade previous link is wrong",
  );
  await install(home, ["--version", "v0.5.0", "--no-path-update"]);
  assert(
    (await reportedVersion(home)) === "0.5.0",
    "explicit downgrade failed",
  );
  assert(
    (await readlink(path.join(installRoot(home), "previous"))).endsWith(
      "versions/0.6.0",
    ),
    "downgrade previous link is wrong",
  );
});

test("failed upgrade preserves active installation", async () => {
  const home = await makeHome("failed-upgrade");
  await install(home, ["--version", "0.5.0", "--no-path-update"]);
  releaseState.checksumOverrides.set(
    "0.6.0",
    `${"0".repeat(64)}  ${releases.get("0.6.0").archiveName}\n`,
  );
  await install(home, ["--no-path-update"], { expectedCode: "nonzero" });
  assert(
    (await reportedVersion(home)) === "0.5.0",
    "failed upgrade broke old binary",
  );
  assert(
    (await readlink(path.join(installRoot(home), "current"))).endsWith(
      "versions/0.5.0",
    ),
    "failed upgrade switched current",
  );
});

test("post-activation failure rolls back", async () => {
  const home = await makeHome("post-activation-rollback");
  await install(home, ["--version", "0.5.0", "--no-path-update"]);
  releaseState.releaseOverrides.set("0.6.0", postActivationFailureRelease);
  const result = await install(home, ["--no-path-update"], {
    expectedCode: "nonzero",
  });
  assert(
    (await reportedVersion(home)) === "0.5.0",
    "post-activation failure broke old binary",
  );
  assert(
    /rollback|restor/i.test(`${result.stdout}${result.stderr}`),
    "rollback status was not reported",
  );
});

test("unknown binary conflict is refused and preserved", async () => {
  const home = await makeHome("unknown-binary");
  await mkdir(binDirectory(home), { recursive: true });
  await writeFile(binary(home), "unknown executable\n", { mode: 0o755 });
  await install(home, ["--no-path-update"], { expectedCode: "nonzero" });
  assert(
    (await readFile(binary(home), "utf8")) === "unknown executable\n",
    "unknown binary was overwritten",
  );
});

test("invalid arguments and destructive roots are refused", async () => {
  for (const arguments_ of [
    ["--version", ""],
    ["--version", "../0.6.0"],
    ["--version", "0.6.0\nother"],
    ["--repository", "not-a-repository"],
    ["--repository", "ting10688/Braid\nother"],
    ["--install-dir", "/"],
    ["--bin-dir", "/"],
    ["--install-dir", "HOME"],
    ["--unknown"],
  ]) {
    const home = await makeHome("invalid");
    const expanded = arguments_.map((argument) =>
      argument === "HOME" ? home : argument,
    );
    await install(home, expanded, { expectedCode: "nonzero" });
    await assertInactive(home);
    assert(
      !(await exists(path.join(home, "current"))),
      "install root equal to HOME was accepted",
    );
  }
});

test("missing exact release is rejected", async () => {
  const exactHome = await makeHome("missing-exact");
  await install(exactHome, ["--version", "9.9.8", "--no-path-update"], {
    expectedCode: "nonzero",
  });
  await assertInactive(exactHome);
});

test("install-root symlink escape is rejected", async () => {
  const home = await makeHome("install-symlink-escape");
  const outside = path.join(home, "outside");
  const root = path.join(home, "linked-root");
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "keep\n");
  await symlink(outside, root);
  await install(home, ["--install-dir", root, "--no-path-update"], {
    expectedCode: "nonzero",
  });
  assert(
    (await readFile(path.join(outside, "sentinel"), "utf8")) === "keep\n",
    "symlink escape modified outside data",
  );
  assert(
    (await readdir(outside)).length === 1,
    "symlink escape installed outside owned root",
  );
});

test("versions-root symlinks are refused without touching outside data", async () => {
  const installHome = await makeHome("install-versions-symlink");
  const root = installRoot(installHome);
  const outside = path.join(installHome, "outside-install");
  await mkdir(root, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "keep\n");
  await symlink(outside, path.join(root, "versions"));
  await install(installHome, ["--no-path-update"], {
    expectedCode: "nonzero",
  });
  assert(
    (await readdir(outside)).join() === "sentinel",
    "installer followed versions symlink outside its root",
  );

  const uninstallHome = await makeHome("uninstall-versions-symlink");
  await install(uninstallHome, ["--no-path-update"]);
  const uninstallRoot = installRoot(uninstallHome);
  const versions = path.join(uninstallRoot, "versions");
  const ownedVersions = path.join(uninstallRoot, "versions-owned");
  const uninstallOutside = path.join(uninstallHome, "outside-uninstall");
  await rename(versions, ownedVersions);
  await mkdir(uninstallOutside);
  await writeFile(path.join(uninstallOutside, "sentinel"), "keep\n");
  await symlink(uninstallOutside, versions);
  await uninstall(uninstallHome, [], { expectedCode: "nonzero" });
  assert(
    (await readdir(uninstallOutside)).join() === "sentinel",
    "uninstaller followed versions symlink outside its root",
  );
  assert(
    await exists(path.join(uninstallRoot, "install-manifest.json")),
    "uninstaller mutated installation before rejecting versions symlink",
  );
  assert(
    (await lstat(binary(uninstallHome))).isSymbolicLink(),
    "uninstaller removed binary before rejecting versions symlink",
  );
});

test("manifestless valid version is never adopted or removed", async () => {
  const home = await makeHome("manifestless-version");
  const versionDirectory = path.join(installRoot(home), "versions", "0.6.0");
  await mkdir(path.dirname(versionDirectory), { recursive: true });
  await cp(sourceDistribution, versionDirectory, { recursive: true });
  const payload = path.join(versionDirectory, "bin", "braid.mjs");
  const before = sha256(await readFile(payload));

  await install(home, ["--no-path-update"], { expectedCode: "nonzero" });
  assert(
    !(await exists(path.join(installRoot(home), "install-manifest.json"))),
    "installer adopted a manifestless version directory",
  );
  assert(
    !(await exists(path.join(installRoot(home), "current"))),
    "installer activated manifestless data",
  );

  await uninstall(home);
  assert(
    await exists(versionDirectory),
    "uninstaller removed manifestless version data",
  );
  assert(
    sha256(await readFile(payload)) === before,
    "manifestless version contents changed",
  );
});

test("PATH install and uninstall preserve a missing final newline", async () => {
  const home = await makeHome("path-no-final-newline");
  const shellFile = path.join(home, ".zshrc");
  const original = Buffer.from("export USER_SETTING=yes");
  await writeFile(shellFile, original);
  await install(home);
  await uninstall(home);
  assert(
    (await readFile(shellFile)).equals(original),
    "PATH lifecycle changed shell final-newline bytes",
  );
});

test("SIGTERM during archive download leaves no temporary or staged state", async () => {
  const home = await makeHome("signal-cleanup");
  const archiveName = releases.get("0.6.0").archiveName;
  const archiveRequest = `/assets/v0.6.0/${archiveName}`;
  releaseState.slow.add(archiveName);
  const child = spawn("sh", [installScript, "--no-path-update"], {
    cwd: home,
    env: environment(home),
    stdio: "ignore",
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitFor(
      () => releaseState.requests.includes(archiveRequest),
      "archive download to start",
    );
    assert(child.kill("SIGTERM"), "could not signal installer");
    let signalTimer;
    const result = await Promise.race([
      closed,
      new Promise(
        (_, reject) =>
          (signalTimer = setTimeout(
            () => reject(new Error("installer ignored SIGTERM")),
            5_000,
          )),
      ),
    ]);
    clearTimeout(signalTimer);
    assert(
      result.code !== 0 || result.signal === "SIGTERM",
      "signalled installer reported success",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(
    !(await readdir(path.join(home, "tmp"))).some((entry) =>
      entry.startsWith("braid-install-"),
    ),
    "SIGTERM leaked installer temporary workspace",
  );
  const root = installRoot(home);
  assert(
    !(await exists(path.join(root, "current"))),
    "SIGTERM activated an incomplete install",
  );
  const versions = path.join(root, "versions");
  if (await exists(versions))
    assert(
      !(await readdir(versions)).some((entry) => entry.startsWith(".")),
      "SIGTERM leaked a staged version directory",
    );
});

test("normal and repeated uninstall preserve project-local state", async () => {
  const home = await makeHome("uninstall");
  const shellFile = path.join(home, ".zshrc");
  await writeFile(shellFile, "before\nafter\n");
  const project = path.join(home, "project");
  await mkdir(path.join(project, ".braid"), { recursive: true });
  await mkdir(path.join(project, ".codex"), { recursive: true });
  await writeFile(path.join(project, ".braid", "state.json"), "{}\n");
  await writeFile(path.join(project, ".codex", "hooks.json"), "{}\n");
  await install(home);
  await uninstall(home);
  assert(!(await exists(binary(home))), "uninstall left binary link");
  assert(
    !(await exists(path.join(installRoot(home), "install-manifest.json"))),
    "uninstall left manifest",
  );
  assert(
    (await readFile(shellFile, "utf8")) === "before\nafter\n",
    "uninstall changed unrelated shell content",
  );
  assert(
    await exists(path.join(project, ".braid", "state.json")),
    "uninstall removed project .braid data",
  );
  assert(
    await exists(path.join(project, ".codex", "hooks.json")),
    "uninstall removed Codex hooks",
  );
  await uninstall(home);
});

test("uninstall keep flags are honored", async () => {
  const versionsHome = await makeHome("keep-versions");
  await install(versionsHome, ["--no-path-update"]);
  await uninstall(versionsHome, ["--keep-versions"]);
  assert(
    await exists(path.join(installRoot(versionsHome), "versions", "0.6.0")),
    "--keep-versions removed version",
  );

  const pathHome = await makeHome("keep-path");
  await install(pathHome);
  const shellFile = path.join(pathHome, ".zshrc");
  await uninstall(pathHome, ["--keep-path"]);
  assert(
    (await readFile(shellFile, "utf8")).includes("# >>> braid installer >>>"),
    "--keep-path removed block",
  );
});

test("uninstall preserves unknown binary and unknown version directory", async () => {
  const home = await makeHome("uninstall-unknown");
  await install(home, ["--no-path-update"]);
  const unknownVersion = path.join(installRoot(home), "versions", "9.9.9");
  await mkdir(unknownVersion);
  await writeFile(path.join(unknownVersion, "owned-by-user"), "keep\n");
  await rm(binary(home));
  await writeFile(binary(home), "unknown\n", { mode: 0o755 });
  await uninstall(home, [], { expectedCode: "nonzero" });
  assert(
    (await readFile(binary(home), "utf8")) === "unknown\n",
    "uninstaller removed unknown binary",
  );
  assert(
    await exists(path.join(unknownVersion, "owned-by-user")),
    "uninstaller removed unknown version data",
  );
});

test("manifest ownership mismatch is refused", async () => {
  const home = await makeHome("ownership-mismatch");
  await install(home, ["--no-path-update"]);
  const manifestPath = path.join(installRoot(home), "install-manifest.json");
  const data = await manifest(home);
  data.installRoot = "/";
  await writeFile(manifestPath, `${JSON.stringify(data, null, 2)}\n`);
  await uninstall(home, [], { expectedCode: "nonzero" });
  assert(await exists(binary(home)), "ownership mismatch removed binary");
  assert(
    await exists(path.join(installRoot(home), "versions", "0.6.0")),
    "ownership mismatch removed version",
  );
});

test("uninstall dry-run performs no mutation", async () => {
  const home = await makeHome("uninstall-dry-run");
  await install(home, ["--no-path-update"]);
  const before = await readFile(
    path.join(installRoot(home), "install-manifest.json"),
    "utf8",
  );
  await uninstall(home, ["--dry-run"]);
  assert(await exists(binary(home)), "uninstall dry-run removed binary");
  assert(
    (await readFile(
      path.join(installRoot(home), "install-manifest.json"),
      "utf8",
    )) === before,
    "uninstall dry-run changed manifest",
  );
});

test("installer does not use sudo, pnpm, or global Git configuration", async () => {
  const home = await makeHome("forbidden-tools");
  const marker = path.join(home, "forbidden-command");
  const tools = await makeToolWrapper(
    home,
    "sudo",
    `echo sudo > '${marker}'; exit 99`,
  );
  await makeToolWrapper(home, "pnpm", `echo pnpm > '${marker}'; exit 99`);
  await install(home, ["--no-path-update"], {
    env: { PATH: `${tools}:${process.env.PATH}` },
  });
  assert(!(await exists(marker)), "installer invoked sudo or pnpm");
  assert(
    !(await exists(path.join(home, ".gitconfig"))),
    "installer changed global Git config",
  );
});

let failures = 0;
try {
  for (const { name, callback } of tests) {
    resetServer();
    currentHomes = [];
    try {
      await callback();
      for (const home of currentHomes)
        assert(
          (await readdir(path.join(home, "tmp"))).length === 0,
          `temporary workspace leaked for ${name}`,
        );
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n${error.stack ?? error}\n`);
    }
  }
} finally {
  for (const response of heldResponses) response.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(suiteRoot, { recursive: true, force: true });
}

assert(failures === 0, `${failures}/${tests.length} installation tests failed`);
process.stdout.write(
  `PASS ${tests.length}/${tests.length} installation tests\n`,
);
