import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MigrationSafetyError } from "@braid/shared";

const execFileAsync = promisify(execFile);

const git = async (arguments_: readonly string[]): Promise<string> =>
  (
    await execFileAsync("git", [...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(stableValue(value));

const repositoryGitDirectoryIdentity = (
  repositoryId: string,
  relativeLocator: string,
): string =>
  sha256(
    stableJson({
      repositoryId,
      relativeLocator,
      gitDirectoryLocator: "repository/.git",
    }),
  );

const stagingGitFingerprint = async (
  repositoryPath: string,
): Promise<string> => {
  const [head, symbolicHead, indexTree, refs, reflogs, config, objects] =
    await Promise.all([
      git(["-C", repositoryPath, "rev-parse", "HEAD"]),
      git(["-C", repositoryPath, "symbolic-ref", "-q", "HEAD"]).catch(() => ""),
      git(["-C", repositoryPath, "write-tree"]),
      git([
        "-C",
        repositoryPath,
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
      ]),
      git([
        "-C",
        repositoryPath,
        "reflog",
        "show",
        "--all",
        "--format=%H%x00%gD%x00%gs",
      ]),
      git(["-C", repositoryPath, "config", "--local", "--null", "--list"]),
      git([
        "-C",
        repositoryPath,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname)",
      ]),
    ]);
  return createHash("sha256")
    .update(
      JSON.stringify({
        head,
        symbolicHead,
        indexTree,
        refs: refs.split("\n").filter(Boolean).sort(),
        reflogs: reflogs.split("\n").filter(Boolean).sort(),
        config: config.split("\0").filter(Boolean).sort(),
        objects: objects.split("\n").filter(Boolean).sort(),
      }),
    )
    .digest("hex");
};

const containedPath = (root: string, relativePath: string): string => {
  const parts = relativePath.split(/[\\/]/u);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    parts.some((part) => ["", ".", ".."].includes(part)) ||
    parts.includes(".git")
  )
    throw new MigrationSafetyError(
      `Executor staging path is unsafe: ${relativePath}`,
      8,
      "executor-staging-path-invalid",
    );
  const destination = path.resolve(root, relativePath);
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new MigrationSafetyError(
      `Executor staging path escapes its root: ${relativePath}`,
      8,
      "executor-staging-path-invalid",
    );
  return destination;
};

const safeDirectory = async (
  root: string,
  relativeDirectory: string,
): Promise<string> => {
  let current = await realpath(root);
  for (const part of relativeDirectory.split("/").filter(Boolean)) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new MigrationSafetyError(
          `Candidate directory is not a real directory: ${relativeDirectory}`,
          8,
          "executor-staging-destination-invalid",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  return current;
};

export interface ExecutorStagingRepository {
  repositoryPath: string;
  durableIdentity?: DurableExecutorStagingIdentity;
  assertGitState(): Promise<void>;
  materialize(
    candidateRoot: string,
    changedFiles: readonly string[],
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface DurableExecutorStagingIdentity {
  schemaVersion: 1;
  resourceType: "staging-repository";
  executionId: string;
  repositoryId: string;
  baseCommit: string;
  relativeLocator: string;
  repositoryGitDirectoryId: string;
  initialGitFingerprint: string;
  markerHash: string;
}

export interface DurableExecutorStagingOptions {
  containerPath: string;
  executionId: string;
  repositoryId: string;
  relativeLocator: string;
}

export const durableExecutorStagingPath = (
  executionRoot: string,
  executionId: string,
): string => path.join(path.resolve(executionRoot), "staging", executionId);

const durableMarkerName = "ownership.json";

const markerHash = (
  identity: Omit<DurableExecutorStagingIdentity, "markerHash">,
): string => sha256(stableJson(identity));

const durableIdentityValid = (
  value: unknown,
): value is DurableExecutorStagingIdentity => {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<DurableExecutorStagingIdentity>;
  if (
    item.schemaVersion !== 1 ||
    item.resourceType !== "staging-repository" ||
    typeof item.executionId !== "string" ||
    !/^E-[0-9a-f-]{36}$/u.test(item.executionId) ||
    typeof item.repositoryId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.repositoryId) ||
    typeof item.baseCommit !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(item.baseCommit) ||
    typeof item.relativeLocator !== "string" ||
    !/^staging\/E-[0-9a-f-]{36}$/u.test(item.relativeLocator) ||
    typeof item.repositoryGitDirectoryId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.repositoryGitDirectoryId) ||
    typeof item.initialGitFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.initialGitFingerprint) ||
    typeof item.markerHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.markerHash)
  )
    return false;
  const { markerHash: actual, ...semantic } =
    item as DurableExecutorStagingIdentity;
  return markerHash(semantic) === actual;
};

const atomicMarker = async (
  container: string,
  identity: DurableExecutorStagingIdentity,
): Promise<void> => {
  const destination = path.join(container, durableMarkerName);
  const temporary = path.join(container, `.ownership-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(stableValue(identity), null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

const stagingHandle = (
  container: string,
  repositoryPath: string,
  initialGitFingerprint: string,
  durableIdentity?: DurableExecutorStagingIdentity,
): ExecutorStagingRepository => ({
  repositoryPath,
  ...(durableIdentity ? { durableIdentity } : {}),
  async assertGitState() {
    if ((await stagingGitFingerprint(repositoryPath)) !== initialGitFingerprint)
      throw new MigrationSafetyError(
        "Executor mutated staging Git state or created Git objects",
        8,
        "executor-created-commit",
      );
  },
  async materialize(candidateRoot, changedFiles) {
    const canonicalStage = await realpath(repositoryPath);
    const canonicalCandidate = await realpath(candidateRoot);
    for (const relativePath of [...new Set(changedFiles)].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const sourcePath = containedPath(canonicalStage, relativePath);
      const canonicalSource = await realpath(sourcePath).catch(() => "");
      if (
        !canonicalSource ||
        (canonicalSource !== canonicalStage &&
          !canonicalSource.startsWith(`${canonicalStage}${path.sep}`))
      )
        throw new MigrationSafetyError(
          `Staged file escapes the executor repository: ${relativePath}`,
          8,
          "executor-staging-source-invalid",
        );
      const handle = await open(
        sourcePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        throw new MigrationSafetyError(
          `Staged file is unavailable or unsafe: ${relativePath}`,
          8,
          "executor-staging-source-invalid",
          { cause: error },
        );
      });
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile())
          throw new MigrationSafetyError(
            `Staged path is not a regular file: ${relativePath}`,
            8,
            "executor-staging-source-invalid",
          );
        const contents = await handle.readFile();
        const relativeDirectory = path.posix.dirname(
          relativePath.replaceAll("\\", "/"),
        );
        const directory = await safeDirectory(
          canonicalCandidate,
          relativeDirectory === "." ? "" : relativeDirectory,
        );
        const destination = containedPath(canonicalCandidate, relativePath);
        const temporary = path.join(
          directory,
          `.braid-stage-${randomUUID()}.tmp`,
        );
        try {
          const existing = await lstat(destination).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          });
          if (existing && (!existing.isFile() || existing.isSymbolicLink()))
            throw new MigrationSafetyError(
              `Candidate destination is not a regular file: ${relativePath}`,
              8,
              "executor-staging-destination-invalid",
            );
          const mode = (existing?.mode ?? metadata.mode) & 0o777;
          await writeFile(temporary, contents, { flag: "wx", mode });
          await chmod(temporary, mode);
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      } finally {
        await handle.close();
      }
    }
  },
  async dispose() {
    if (durableIdentity) {
      const raw: unknown = JSON.parse(
        await readFile(path.join(container, durableMarkerName), "utf8"),
      );
      if (
        !durableIdentityValid(raw) ||
        raw.markerHash !== durableIdentity.markerHash
      )
        throw new MigrationSafetyError(
          "Executor staging ownership is ambiguous",
          12,
          "executor-staging-ownership-invalid",
        );
    }
    await rm(container, { recursive: true });
  },
});

export const createExecutorStagingRepository = async (
  sourceRepository: string,
  baseCommit: string,
  durable?: DurableExecutorStagingOptions,
): Promise<ExecutorStagingRepository> => {
  const container = durable
    ? path.resolve(durable.containerPath)
    : await mkdtemp(path.join(tmpdir(), "braid-executor-stage-"));
  if (durable) {
    await mkdir(path.dirname(container), { recursive: true });
    await mkdir(container);
  }
  const repositoryPath = path.join(container, "repository");
  const hooksPath = path.join(container, "disabled-hooks");
  await mkdir(hooksPath);
  try {
    await git([
      "-c",
      `core.hooksPath=${hooksPath}`,
      "clone",
      "--no-local",
      "--no-checkout",
      "--quiet",
      "--",
      sourceRepository,
      repositoryPath,
    ]);
    await git([
      "-C",
      repositoryPath,
      "-c",
      `core.hooksPath=${hooksPath}`,
      "checkout",
      "--detach",
      "--quiet",
      baseCommit,
    ]);
    await git(["-C", repositoryPath, "remote", "remove", "origin"]);
    const [head, status, remotes, gitDirectory] = await Promise.all([
      git(["-C", repositoryPath, "rev-parse", "HEAD"]),
      git([
        "-C",
        repositoryPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      git(["-C", repositoryPath, "remote"]),
      realpath(path.join(repositoryPath, ".git")),
    ]);
    const canonicalContainer = await realpath(container);
    if (
      head !== baseCommit ||
      status !== "" ||
      remotes !== "" ||
      !gitDirectory.startsWith(`${canonicalContainer}${path.sep}`)
    )
      throw new MigrationSafetyError(
        "Executor staging repository failed isolation verification",
        7,
        "executor-staging-verification-failed",
      );
    const initialGitFingerprint = await stagingGitFingerprint(repositoryPath);
    let identity: DurableExecutorStagingIdentity | undefined;
    if (durable) {
      const semantic = {
        schemaVersion: 1 as const,
        resourceType: "staging-repository" as const,
        executionId: durable.executionId,
        repositoryId: durable.repositoryId,
        baseCommit,
        relativeLocator: durable.relativeLocator,
        repositoryGitDirectoryId: repositoryGitDirectoryIdentity(
          durable.repositoryId,
          durable.relativeLocator,
        ),
        initialGitFingerprint,
      };
      identity = { ...semantic, markerHash: markerHash(semantic) };
      await atomicMarker(container, identity);
    }
    return stagingHandle(
      container,
      repositoryPath,
      initialGitFingerprint,
      identity,
    );
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
};

export const loadExecutorStagingRepository = async (input: {
  containerPath: string;
  executionId: string;
  repositoryId: string;
  baseCommit: string;
  expectedMarkerHash: string;
}): Promise<ExecutorStagingRepository> => {
  const container = await realpath(path.resolve(input.containerPath)).catch(
    () => "",
  );
  if (!container)
    throw new MigrationSafetyError(
      "Executor staging repository is missing",
      12,
      "executor-staging-missing",
    );
  const marker: unknown = JSON.parse(
    await readFile(path.join(container, durableMarkerName), "utf8"),
  );
  if (
    !durableIdentityValid(marker) ||
    marker.executionId !== input.executionId ||
    marker.repositoryId !== input.repositoryId ||
    marker.baseCommit !== input.baseCommit ||
    marker.markerHash !== input.expectedMarkerHash
  )
    throw new MigrationSafetyError(
      "Executor staging ownership evidence is invalid",
      12,
      "executor-staging-ownership-invalid",
    );
  const repositoryPath = path.join(container, "repository");
  const [head, remotes, gitDirectory] = await Promise.all([
    git(["-C", repositoryPath, "rev-parse", "HEAD"]),
    git(["-C", repositoryPath, "remote"]),
    realpath(path.join(repositoryPath, ".git")),
  ]);
  if (
    head !== input.baseCommit ||
    remotes !== "" ||
    !gitDirectory.startsWith(`${container}${path.sep}`) ||
    repositoryGitDirectoryIdentity(
      marker.repositoryId,
      marker.relativeLocator,
    ) !== marker.repositoryGitDirectoryId ||
    (await stagingGitFingerprint(repositoryPath)) !==
      marker.initialGitFingerprint
  )
    throw new MigrationSafetyError(
      "Executor staging repository no longer matches owned Git state",
      12,
      "executor-staging-state-invalid",
    );
  return stagingHandle(
    container,
    repositoryPath,
    marker.initialGitFingerprint,
    marker,
  );
};
