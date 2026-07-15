import { createHash } from "node:crypto";
import {
  access,
  glob,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  repositoryManifestSchema,
  type RepositoryManifest,
} from "../models/benchmark.js";
import { runCommand, type CommandResult } from "../runner/command-runner.js";

const repositoryId = (value: string): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
    throw new Error(`Invalid repository ID: ${value}`);
  return value;
};

export const repositoryMetadataPath = (
  benchmarksRoot: string,
  id: string,
): string => path.join(benchmarksRoot, "repositories", repositoryId(id));

export const repositoryCachePath = (cacheRoot: string, id: string): string => {
  const root = path.resolve(cacheRoot);
  const resolved = path.resolve(root, repositoryId(id));
  if (!resolved.startsWith(`${root}${path.sep}`))
    throw new Error(`Repository cache path escapes cache root: ${id}`);
  return resolved;
};

export const loadRepositoryManifest = async (
  benchmarksRoot: string,
  id: string,
): Promise<RepositoryManifest> => {
  const directory = repositoryMetadataPath(benchmarksRoot, id);
  const manifest = repositoryManifestSchema.parse(
    parse(await readFile(path.join(directory, "repository.yaml"), "utf8")),
  );
  if (
    (await sha256File(
      path.join(directory, manifest.braidConfiguration.file),
    )) !== manifest.braidConfiguration.hash
  )
    throw new Error(`${manifest.id} Braid configuration mismatch`);
  return manifest;
};

export const listRepositoryManifests = async (
  benchmarksRoot: string,
): Promise<RepositoryManifest[]> => {
  const manifests: RepositoryManifest[] = [];
  for await (const file of glob("*/repository.yaml", {
    cwd: path.join(benchmarksRoot, "repositories"),
  }))
    manifests.push(
      await loadRepositoryManifest(benchmarksRoot, file.split("/")[0]!),
    );
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
};

export const sha256File = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const includedFiles = async (
  root: string,
  include: readonly string[],
  exclude: readonly string[],
): Promise<string[]> => {
  const files = new Set<string>();
  for await (const file of glob(include, { cwd: root, exclude })) {
    const absolute = path.join(root, file);
    if ((await stat(absolute)).isFile())
      files.add(file.replaceAll(path.sep, "/"));
  }
  return [...files].sort();
};

const sourceLines = (contents: string): number =>
  contents.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== "" &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      trimmed !== "*/"
    );
  }).length;

const moduleFor = (file: string): string => {
  const segments = file.split("/");
  const sourceIndex = segments.lastIndexOf("src");
  const first = segments[sourceIndex + 1];
  if (!first || path.posix.extname(first)) return "root";
  if (
    first === "modules" &&
    segments[sourceIndex + 2] &&
    !path.posix.extname(segments[sourceIndex + 2]!)
  )
    return `modules/${segments[sourceIndex + 2]}`;
  return first;
};

export interface RepositorySourceStats {
  manifestHash: string;
  fileCount: number;
  testFileCount: number;
  linesOfCode: number;
  moduleCount: number;
  preferredRange: "below" | "within" | "above";
  largestFiles: Array<{ path: string; linesOfCode: number }>;
}

export const repositorySourceStats = async (
  root: string,
  manifest: RepositoryManifest,
): Promise<RepositorySourceStats> => {
  const files = await includedFiles(
    root,
    manifest.source.include,
    manifest.source.exclude,
  );
  const tests = await includedFiles(
    root,
    manifest.source.tests,
    manifest.source.testExclude,
  );
  const records = await Promise.all(
    files.map(async (file) => {
      const contents = await readFile(path.join(root, file), "utf8");
      return {
        path: file,
        contentHash: createHash("sha256").update(contents).digest("hex"),
        linesOfCode: sourceLines(contents),
      };
    }),
  );
  return {
    manifestHash: createHash("sha256")
      .update(
        JSON.stringify(
          records.map(({ path: file, contentHash }) => ({
            path: file,
            contentHash,
          })),
        ),
      )
      .digest("hex"),
    fileCount: records.length,
    testFileCount: tests.length,
    linesOfCode: records.reduce(
      (total, record) => total + record.linesOfCode,
      0,
    ),
    moduleCount: new Set(files.map(moduleFor)).size,
    preferredRange:
      records.length < 30 ? "below" : records.length > 150 ? "above" : "within",
    largestFiles: records
      .map(({ path: file, linesOfCode }) => ({ path: file, linesOfCode }))
      .sort(
        (left, right) =>
          right.linesOfCode - left.linesOfCode ||
          left.path.localeCompare(right.path),
      )
      .slice(0, 10),
  };
};

export interface RepositoryVerification {
  id: string;
  cache: "verified";
  head: string;
  detached: true;
  remoteUrl: string;
  pushDisabled: true;
  licenseHash: string;
  lockfileHash: string;
  source: RepositorySourceStats;
}

const checked = async (
  command: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<CommandResult> => {
  const result = await runCommand(command, { cwd, timeoutMs });
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result;
};

const assertRecordedStats = (
  manifest: RepositoryManifest,
  actual: RepositorySourceStats,
): void => {
  const recorded = manifest.source;
  for (const [name, expected, value] of [
    ["source manifest", recorded.manifestHash, actual.manifestHash],
    ["source file count", recorded.fileCount, actual.fileCount],
    ["test file count", recorded.testFileCount, actual.testFileCount],
    ["source LOC", recorded.linesOfCode, actual.linesOfCode],
    ["module count", recorded.moduleCount, actual.moduleCount],
    ["preferred range", recorded.preferredRange, actual.preferredRange],
  ] as const)
    if (expected !== value)
      throw new Error(
        `${manifest.id} ${name} mismatch: ${value} != ${expected}`,
      );
  if (
    JSON.stringify(recorded.largestFiles) !==
    JSON.stringify(actual.largestFiles)
  )
    throw new Error(`${manifest.id} largest source files mismatch`);
};

const verifyRepositoryRoot = async (
  manifest: RepositoryManifest,
  root: string,
): Promise<RepositoryVerification> => {
  await access(root);
  const head = (
    await checked(["git", "rev-parse", "HEAD"], root)
  ).stdout.trim();
  if (head !== manifest.repository.commit)
    throw new Error(`${manifest.id} commit mismatch: ${head}`);
  const symbolic = await runCommand(["git", "symbolic-ref", "-q", "HEAD"], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (symbolic.exitCode === 0)
    throw new Error(`${manifest.id} cache must use a detached checkout`);
  const remoteUrl = (
    await checked(["git", "remote", "get-url", "origin"], root)
  ).stdout.trim();
  if (remoteUrl !== manifest.repository.url)
    throw new Error(`${manifest.id} remote mismatch: ${remoteUrl}`);
  const pushUrl = (
    await checked(["git", "remote", "get-url", "--push", "origin"], root)
  ).stdout.trim();
  if (pushUrl !== "DISABLED")
    throw new Error(`${manifest.id} cache push URL is not disabled`);
  const status = (
    await checked(
      ["git", "status", "--porcelain", "--untracked-files=no"],
      root,
    )
  ).stdout.trim();
  if (status) throw new Error(`${manifest.id} cache has tracked mutations`);

  const licenseHash = await sha256File(path.join(root, manifest.license.file));
  if (licenseHash !== manifest.license.contentHash)
    throw new Error(`${manifest.id} license mismatch`);
  const lockfileHash = await sha256File(
    path.join(root, manifest.packageManager.lockfile),
  );
  if (lockfileHash !== manifest.packageManager.lockfileHash)
    throw new Error(`${manifest.id} lockfile mismatch`);
  const source = await repositorySourceStats(root, manifest);
  assertRecordedStats(manifest, source);
  return {
    id: manifest.id,
    cache: "verified",
    head,
    detached: true,
    remoteUrl,
    pushDisabled: true,
    licenseHash,
    lockfileHash,
    source,
  };
};

export const verifyRepositoryCache = async (
  manifest: RepositoryManifest,
  cacheRoot: string,
): Promise<RepositoryVerification> =>
  verifyRepositoryRoot(manifest, repositoryCachePath(cacheRoot, manifest.id));

export interface MaterializedRepository {
  workdir: string;
  verification: RepositoryVerification;
}

export const materializeRepository = async (
  manifest: RepositoryManifest,
  cacheRoot: string,
): Promise<MaterializedRepository> => {
  const verification = await verifyRepositoryCache(manifest, cacheRoot);
  const workdir = await mkdtemp(
    path.join(tmpdir(), `braid-bench-${manifest.id}-`),
  );
  try {
    await checked(
      [
        "git",
        "clone",
        "--quiet",
        "--no-hardlinks",
        repositoryCachePath(cacheRoot, manifest.id),
        workdir,
      ],
      path.dirname(workdir),
    );
    await checked(
      ["git", "checkout", "--quiet", "--detach", manifest.repository.commit],
      workdir,
    );
    await checked(["git", "remote", "remove", "origin"], workdir);
    const remotes = (await checked(["git", "remote"], workdir)).stdout.trim();
    if (remotes)
      throw new Error(`${manifest.id} temporary clone retained a remote`);
    const source = await repositorySourceStats(workdir, manifest);
    if (source.manifestHash !== verification.source.manifestHash)
      throw new Error(`${manifest.id} temporary source manifest mismatch`);
    return { workdir, verification };
  } catch (error) {
    await rm(workdir, { force: true, recursive: true });
    throw error;
  }
};

export const removeMaterializedRepository = async (
  workdir: string,
): Promise<void> => rm(workdir, { force: true, recursive: true });

export type RepositoryCommandExecutor = (
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

const defaultExecutor: RepositoryCommandExecutor = (command, cwd, timeoutMs) =>
  runCommand(command, { cwd, timeoutMs });

export const clonePinnedRepository = async (
  manifest: RepositoryManifest,
  destination: string,
  execute: RepositoryCommandExecutor = defaultExecutor,
): Promise<void> => {
  const run = async (command: readonly string[]): Promise<void> => {
    const result = await execute(command, path.dirname(destination), 120_000);
    if (result.exitCode !== 0)
      throw new Error(
        `Repository clone failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  };
  await run([
    "git",
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--depth=1",
    manifest.repository.url,
    destination,
  ]);
  const inside = async (arguments_: readonly string[]): Promise<void> => {
    const result = await execute(
      ["git", "-C", destination, ...arguments_],
      path.dirname(destination),
      120_000,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Repository clone failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  };
  await inside(["fetch", "--depth=1", "origin", manifest.repository.commit]);
  await inside(["checkout", "--detach", manifest.repository.commit]);
  await inside(["remote", "set-url", "--push", "origin", "DISABLED"]);
};

export const refreshRepositoryCache = async (
  manifest: RepositoryManifest,
  cacheRoot: string,
): Promise<RepositoryVerification> => {
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(
    path.join(path.resolve(cacheRoot), `.${manifest.id}-refresh-`),
  );
  try {
    await clonePinnedRepository(manifest, temporary);
    const verification = await verifyRepositoryRoot(manifest, temporary);
    const target = repositoryCachePath(cacheRoot, manifest.id);
    await rm(target, { force: true, recursive: true });
    await rename(temporary, target);
    return { ...verification, id: manifest.id };
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
};
