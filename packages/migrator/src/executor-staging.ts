import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
  assertGitState(): Promise<void>;
  materialize(
    candidateRoot: string,
    changedFiles: readonly string[],
  ): Promise<void>;
  dispose(): Promise<void>;
}

export const createExecutorStagingRepository = async (
  sourceRepository: string,
  baseCommit: string,
): Promise<ExecutorStagingRepository> => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-executor-stage-"));
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

    return {
      repositoryPath,
      async assertGitState() {
        if (
          (await stagingGitFingerprint(repositoryPath)) !==
          initialGitFingerprint
        )
          throw new MigrationSafetyError(
            "Executor mutated staging Git state or created Git objects",
            8,
            "executor-created-commit",
          );
      },
      async materialize(candidateRoot, changedFiles) {
        const canonicalStage = await realpath(repositoryPath);
        const canonicalCandidate = await realpath(candidateRoot);
        for (const relativePath of [...new Set(changedFiles)].sort(
          (left, right) => left.localeCompare(right),
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
              const existing = await lstat(destination).catch(
                (error: unknown) => {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT")
                    return;
                  throw error;
                },
              );
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
        await rm(container, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
};
