import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  repositoryManifestSchema,
  type RepositoryManifest,
} from "../src/models/benchmark.js";
import {
  clonePinnedRepository,
  materializeRepository,
  removeMaterializedRepository,
  repositoryCachePath,
  repositorySourceStats,
  sha256File,
  verifyRepositoryCache,
} from "../src/repositories/repository-materializer.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const git = async (cwd: string, ...arguments_: string[]): Promise<string> =>
  (await execFileAsync("git", arguments_, { cwd })).stdout.trim();

const commandStatus = {
  status: "passed" as const,
  command: "true",
  detail: "passed",
};

const createCache = async (): Promise<{
  root: string;
  cacheRoot: string;
  repository: string;
  manifest: RepositoryManifest;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-repository-test-"));
  temporaryDirectories.push(root);
  const cacheRoot = path.join(root, "cache");
  const repository = path.join(cacheRoot, "example");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "tests"), { recursive: true });
  await writeFile(path.join(repository, "LICENSE"), "MIT License\n", "utf8");
  await writeFile(path.join(repository, "package-lock.json"), "{}\n", "utf8");
  await writeFile(
    path.join(repository, "src", "index.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await writeFile(
    path.join(repository, "tests", "index.test.ts"),
    "export {};\n",
    "utf8",
  );
  await git(repository, "init", "--quiet");
  await git(repository, "config", "user.name", "Braid Bench");
  await git(repository, "config", "user.email", "benchmark@example.invalid");
  await git(repository, "add", ".");
  await git(repository, "commit", "--quiet", "-m", "fixture");
  const commit = await git(repository, "rev-parse", "HEAD");
  await git(
    repository,
    "remote",
    "add",
    "origin",
    "https://github.com/example/offline.git",
  );
  await git(repository, "remote", "set-url", "--push", "origin", "DISABLED");
  await git(repository, "checkout", "--quiet", "--detach", commit);

  const draft = repositoryManifestSchema.parse({
    schemaVersion: 1,
    id: "example",
    title: "Example",
    role: "control",
    repository: {
      url: "https://github.com/example/offline.git",
      commit,
    },
    license: {
      spdxId: "MIT",
      file: "LICENSE",
      contentHash: "a".repeat(64),
      attribution: "Example",
    },
    packageManager: {
      name: "npm",
      version: "1",
      lockfile: "package-lock.json",
      lockfileHash: "b".repeat(64),
    },
    environment: { node: ">=20", networkRequiredAfterCheckout: false },
    source: {
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      tests: ["tests/**/*.test.ts"],
      testExclude: [],
      manifestHash: "c".repeat(64),
      fileCount: 0,
      testFileCount: 0,
      linesOfCode: 0,
      moduleCount: 0,
      preferredRange: "below",
      largestFiles: [],
    },
    braidConfiguration: { file: "braid-config.yaml", hash: "d".repeat(64) },
    commands: {
      install: { executable: "npm", arguments: ["ci", "--ignore-scripts"] },
      build: { executable: "npm", arguments: ["run", "build"] },
      test: { executable: "npm", arguments: ["test"] },
    },
    qualification: {
      status: "qualified",
      reviewedAt: "2026-07-15",
      install: commandStatus,
      build: commandStatus,
      test: commandStatus,
      braidAnalysis: commandStatus,
      limitations: [],
    },
  });
  const source = await repositorySourceStats(repository, draft);
  const manifest = repositoryManifestSchema.parse({
    ...draft,
    license: {
      ...draft.license,
      contentHash: await sha256File(path.join(repository, "LICENSE")),
    },
    packageManager: {
      ...draft.packageManager,
      lockfileHash: await sha256File(
        path.join(repository, "package-lock.json"),
      ),
    },
    source: { ...draft.source, ...source },
  });
  return { root, cacheRoot, repository, manifest };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("repository materializer", () => {
  it("validates cache paths, exact pins, hashes, and detached state", async () => {
    const { cacheRoot, manifest, repository } = await createCache();
    expect(() => repositoryCachePath(cacheRoot, "../escape")).toThrow();
    await expect(
      verifyRepositoryCache(manifest, cacheRoot),
    ).resolves.toMatchObject({
      head: manifest.repository.commit,
      detached: true,
      pushDisabled: true,
      source: { fileCount: 1, testFileCount: 1, linesOfCode: 1 },
    });

    await git(repository, "switch", "--quiet", "-c", "moving");
    await expect(verifyRepositoryCache(manifest, cacheRoot)).rejects.toThrow(
      /detached/u,
    );
  });

  it("reports commit, license, lockfile, and source-manifest mismatches", async () => {
    const { cacheRoot, manifest } = await createCache();
    await expect(
      verifyRepositoryCache(
        {
          ...manifest,
          repository: { ...manifest.repository, commit: "f".repeat(40) },
        },
        cacheRoot,
      ),
    ).rejects.toThrow(/commit mismatch/u);
    await expect(
      verifyRepositoryCache(
        {
          ...manifest,
          license: { ...manifest.license, contentHash: "f".repeat(64) },
        },
        cacheRoot,
      ),
    ).rejects.toThrow(/license mismatch/u);
    await expect(
      verifyRepositoryCache(
        {
          ...manifest,
          packageManager: {
            ...manifest.packageManager,
            lockfileHash: "f".repeat(64),
          },
        },
        cacheRoot,
      ),
    ).rejects.toThrow(/lockfile mismatch/u);
    await expect(
      verifyRepositoryCache(
        {
          ...manifest,
          source: { ...manifest.source, manifestHash: "f".repeat(64) },
        },
        cacheRoot,
      ),
    ).rejects.toThrow(/source manifest mismatch/u);
  });

  it("materializes an isolated network-free copy and removes its remote", async () => {
    const { cacheRoot, manifest, repository } = await createCache();
    const before = await readFile(
      path.join(repository, "src", "index.ts"),
      "utf8",
    );
    const materialized = await materializeRepository(manifest, cacheRoot);
    temporaryDirectories.push(materialized.workdir);
    expect(await git(materialized.workdir, "remote")).toBe("");
    expect(await git(materialized.workdir, "rev-parse", "HEAD")).toBe(
      manifest.repository.commit,
    );
    await writeFile(
      path.join(materialized.workdir, "src", "index.ts"),
      "changed\n",
      "utf8",
    );
    expect(
      await readFile(path.join(repository, "src", "index.ts"), "utf8"),
    ).toBe(before);
    await removeMaterializedRepository(materialized.workdir);
    temporaryDirectories.pop();
  });

  it("surfaces clone failures without leaving partial work", async () => {
    const { root, manifest } = await createCache();
    const destination = path.join(root, "failed-clone");
    await expect(
      clonePinnedRepository(manifest, destination, async () => ({
        exitCode: 128,
        durationMs: 1,
        stdout: "",
        stderr: "offline clone failed",
        timedOut: false,
      })),
    ).rejects.toThrow(/offline clone failed/u);
  });
});
