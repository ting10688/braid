import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
const version = packageJson.version;
const artifactName = `braid-v${version}-demo-node22`;
const artifacts = path.join(repository, ".artifacts");
const distribution = path.join(artifacts, artifactName);
const tarArchive = path.join(artifacts, `${artifactName}.tar.gz`);
const zipArchive = path.join(artifacts, `${artifactName}.zip`);
const releaseChecksums = path.join(artifacts, "SHA256SUMS");
const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const walkFiles = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported distribution entry: ${relative}`);
  }
  return files.sort();
};

await access(distribution);
await access(tarArchive);
await access(zipArchive);
await access(releaseChecksums);

const expectedReleaseChecksums = (
  await Promise.all(
    [tarArchive, zipArchive].map(
      async (file) => `${sha256(await readFile(file))}  ${path.basename(file)}`,
    ),
  )
).join("\n");
assert(
  (await readFile(releaseChecksums, "utf8")).trim() ===
    expectedReleaseChecksums,
  "Release SHA256SUMS is incomplete or invalid",
);

const files = await walkFiles(distribution);
for (const required of [
  "LICENSE",
  "README.md",
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.md",
  "bin/braid",
  "bin/braid.cmd",
  "bin/braid.mjs",
  "braid-demo",
  "demo/run-demo.mjs",
  "manifest.json",
])
  assert(
    files.includes(required),
    `Missing required distribution file: ${required}`,
  );

assert(
  !files.some((file) => file.startsWith("node_modules/")),
  "Distribution contains node_modules",
);
assert(
  !files.some((file) => file.startsWith("packages/")),
  "Distribution contains workspace packages",
);
for (const file of files) {
  const contents = await readFile(path.join(distribution, file));
  assert(
    !contents.includes(Buffer.from(repository)),
    `Developer checkout path found in ${file}`,
  );
}

const manifest = JSON.parse(
  await readFile(path.join(distribution, "manifest.json"), "utf8"),
);
assert(
  manifest.schemaVersion === "1.0.0",
  "Unexpected manifest schema version",
);
assert(manifest.name === artifactName, "Unexpected manifest name");
assert(manifest.braidVersion === version, "Unexpected manifest Braid version");
const expectedPayload = files.filter(
  (file) => file !== "manifest.json" && file !== "SHA256SUMS",
);
assert(
  JSON.stringify(manifest.files.map((file) => file.path)) ===
    JSON.stringify(expectedPayload),
  "Manifest payload is incomplete or not deterministically sorted",
);
for (const file of manifest.files) {
  const contents = await readFile(path.join(distribution, file.path));
  assert(
    file.sha256 === sha256(contents),
    `Manifest checksum mismatch: ${file.path}`,
  );
  assert(file.size === contents.length, `Manifest size mismatch: ${file.path}`);
}

const checksumLines = (
  await readFile(path.join(distribution, "SHA256SUMS"), "utf8")
)
  .trim()
  .split("\n");
const checksumEntries = checksumLines.map((line) => {
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
  assert(match, `Invalid SHA256SUMS line: ${line}`);
  return { hash: match[1], file: match[2] };
});
const expectedChecksums = files.filter((file) => file !== "SHA256SUMS");
assert(
  JSON.stringify(checksumEntries.map((entry) => entry.file)) ===
    JSON.stringify(expectedChecksums),
  "SHA256SUMS is incomplete or not deterministically sorted",
);
for (const entry of checksumEntries) {
  const contents = await readFile(path.join(distribution, entry.file));
  assert(entry.hash === sha256(contents), `SHA256SUMS mismatch: ${entry.file}`);
}

const notices = await readFile(
  path.join(distribution, "THIRD_PARTY_NOTICES.md"),
  "utf8",
);
assert(
  notices.includes("typescript@"),
  "TypeScript compiler notice is missing",
);
assert(notices.includes("Apache License"), "Apache license text is missing");
assert(
  notices.includes("commander@"),
  "Bundled CLI dependency notice is missing",
);
assert(
  (await stat(path.join(distribution, "bin", "braid"))).mode & 0o111,
  "CLI launcher is not executable",
);
assert(
  (await stat(path.join(distribution, "braid-demo"))).mode & 0o111,
  "Demo launcher is not executable",
);

const archiveFiles = files.map((file) => `${artifactName}/${file}`);
const { stdout: tarList } = await execFileAsync("tar", ["-tzf", tarArchive], {
  encoding: "utf8",
});
const tarFiles = tarList
  .trim()
  .split("\n")
  .filter((file) => file && !file.endsWith("/"))
  .sort();
assert(
  JSON.stringify(tarFiles) === JSON.stringify(archiveFiles),
  "tar.gz logical contents differ",
);
const { stdout: zipList } = await execFileAsync("unzip", ["-Z1", zipArchive], {
  encoding: "utf8",
});
const zipFiles = zipList
  .trim()
  .split("\n")
  .filter((file) => file && !file.endsWith("/"))
  .sort();
assert(
  JSON.stringify(zipFiles) === JSON.stringify(archiveFiles),
  "zip logical contents differ",
);

const temporary = await mkdtemp(
  path.join(tmpdir(), "braid-distribution-verify-"),
);
try {
  const cleanDistribution = path.join(temporary, artifactName);
  await cp(distribution, cleanDistribution, { recursive: true });
  const environment = {
    ...process.env,
    NODE_PATH: "",
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
  };
  const run = (command, arguments_, cwd = temporary) =>
    execFileAsync(command, arguments_, {
      cwd,
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });

  const cli = path.join(cleanDistribution, "bin", "braid.mjs");
  const { stdout: reportedVersion } = await run(process.execPath, [
    cli,
    "--version",
  ]);
  assert(
    reportedVersion.trim() === version,
    `Standalone CLI reported ${reportedVersion.trim()}`,
  );
  const { stdout: help } = await run(process.execPath, [cli, "--help"]);
  assert(help.includes("Usage: braid"), "Standalone CLI help did not start");

  const { stdout: demo } = await run(
    path.join(cleanDistribution, "braid-demo"),
    [],
  );
  for (const expected of [
    "Status: PASS",
    "Status: BLOCK",
    "First attempt: BLOCKED",
    "Unchanged retry: ALLOWED WITH VISIBLE UNRESOLVED FINDING",
    "Braid source mutations: 0",
    "Braid Git mutations: 0",
    "Temporary repository cleaned: yes",
  ])
    assert(demo.includes(expected), `Demo output is missing: ${expected}`);

  const { stdout: keptDemo } = await run(process.execPath, [
    path.join(cleanDistribution, "demo", "run-demo.mjs"),
    "--keep",
  ]);
  const kept = /Temporary repository kept: (.+)/.exec(keptDemo)?.[1]?.trim();
  assert(kept, "--keep did not report the retained repository");
  await access(kept);
  await rm(path.dirname(kept), { recursive: true, force: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write(`Verified ${distribution}\n`);
