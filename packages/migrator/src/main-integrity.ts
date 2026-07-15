import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MigrationSafetyError } from "@braid/shared";
import { createSourceFingerprint } from "./source-fingerprint.js";

const execFileAsync = promisify(execFile);

export interface MainCheckoutState {
  head: string;
  symbolicHead: string;
  indexTree: string;
  sourceFingerprint: string;
  statusFingerprint: string;
  repositoryMetadataFingerprint: string;
  fingerprint: string;
  clean: boolean;
}

export interface CaptureMainCheckoutStateOptions {
  ownedCandidateRef?: string;
  ownedWorktreeGitDirectory?: string;
}

const runtimePath = (filePath: string): boolean =>
  filePath.startsWith(".braid/state/") ||
  filePath.startsWith(".braid/executions/");

const statusPaths = (status: string): string[] =>
  status
    .split("\0")
    .filter(Boolean)
    .filter((entry) => {
      const tab = entry.lastIndexOf("\t");
      const filePath = (
        tab >= 0 ? entry.slice(tab + 1) : entry.split(" ").at(-1)!
      ).replaceAll("\\", "/");
      return !runtimePath(filePath);
    })
    .sort();

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const protectedMetadata = async (
  commonDirectory: string,
  options: CaptureMainCheckoutStateOptions,
): Promise<string[]> => {
  const excluded = new Set<string>();
  if (options.ownedCandidateRef) {
    excluded.add(options.ownedCandidateRef);
    excluded.add(`logs/${options.ownedCandidateRef}`);
  }
  if (options.ownedWorktreeGitDirectory) {
    const relative = path.relative(
      commonDirectory,
      path.resolve(options.ownedWorktreeGitDirectory),
    );
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !relative.startsWith(`worktrees${path.sep}`)
    )
      throw new MigrationSafetyError(
        "Owned worktree Git directory is outside the common Git directory",
        11,
        "invalid-owned-worktree-git-directory",
      );
    excluded.add(relative.split(path.sep).join("/"));
  }
  const entries: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const normalized = relativePath.split(path.sep).join("/");
    if (
      [...excluded].some(
        (candidate) =>
          normalized === candidate || normalized.startsWith(`${candidate}/`),
      )
    )
      return;
    const absolutePath = path.join(commonDirectory, relativePath);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isDirectory()) {
      const children = await readdir(absolutePath);
      for (const child of children.sort((left, right) =>
        left.localeCompare(right),
      ))
        await visit(path.join(relativePath, child));
      return;
    }
    const fileType = metadata.isSymbolicLink() ? "symlink" : "file";
    const contents =
      fileType === "symlink"
        ? await readlink(absolutePath)
        : await readFile(absolutePath);
    entries.push(
      JSON.stringify([
        normalized,
        fileType,
        metadata.mode & 0o777,
        createHash("sha256").update(contents).digest("hex"),
      ]),
    );
  };
  const objectMetadata = async (): Promise<void> => {
    await visit("objects/info");
    let roots: string[];
    try {
      roots = await readdir(path.join(commonDirectory, "objects"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const root of roots.sort((left, right) => left.localeCompare(right))) {
      if (root === "info") continue;
      const rootPath = path.join("objects", root);
      if (root.endsWith(".lock") || root.startsWith("tmp_")) {
        await visit(rootPath);
        continue;
      }
      if (root !== "pack" && !/^[a-f0-9]{2}$/u.test(root)) continue;
      let children: string[];
      try {
        children = await readdir(path.join(commonDirectory, rootPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const child of children.sort((left, right) =>
        left.localeCompare(right),
      ))
        if (child.endsWith(".lock") || child.startsWith("tmp_"))
          await visit(path.join(rootPath, child));
    }
  };
  const roots = await readdir(commonDirectory);
  for (const root of roots.sort((left, right) => left.localeCompare(right)))
    if (root === "objects") await objectMetadata();
    else await visit(root);
  return entries.sort((left, right) => left.localeCompare(right));
};

const captureMainCheckoutStateUnchecked = async (
  repositoryRoot: string,
  options: CaptureMainCheckoutStateOptions = {},
): Promise<MainCheckoutState> => {
  if (
    options.ownedCandidateRef !== undefined &&
    !/^refs\/heads\/braid\/exec\/[a-f0-9]{8}$/u.test(options.ownedCandidateRef)
  )
    throw new MigrationSafetyError(
      "Main-integrity ref exclusion is not an owned candidate ref",
      11,
      "invalid-owned-candidate-ref",
    );
  const head = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  const symbolicHead = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "symbolic-ref", "-q", "HEAD"],
    { encoding: "utf8" },
  ).catch(() => ({ stdout: "" }));
  // Git status may refresh the shared index, so keep index readers sequential.
  const indexTree = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "write-tree"],
    { encoding: "utf8" },
  );
  const status = await execFileAsync(
    "git",
    [
      "-C",
      repositoryRoot,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const source = await createSourceFingerprint(repositoryRoot);
  const repositoryConfig = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "config", "--local", "--null", "--list"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const sharedRefs = await execFileAsync(
    "git",
    [
      "-C",
      repositoryRoot,
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const commonDirectoryOutput = await execFileAsync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  );
  const commonDirectory = await realpath(
    path.resolve(repositoryRoot, commonDirectoryOutput.stdout.trim()),
  );
  const metadata = await protectedMetadata(commonDirectory, options);
  const paths = statusPaths(status.stdout);
  const stableConfig = repositoryConfig.stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const protectedRefs = sharedRefs.stdout
    .split("\n")
    .filter(Boolean)
    .filter((entry) => entry.split("\0", 1)[0] !== options.ownedCandidateRef)
    .sort();
  const normalized = {
    head: head.stdout.trim(),
    symbolicHead: symbolicHead.stdout.trim(),
    indexTree: indexTree.stdout.trim(),
    sourceFingerprint: source.hash,
    statusFingerprint: hash(paths),
    repositoryMetadataFingerprint: hash({
      stableConfig,
      protectedRefs,
      metadata,
    }),
  };
  return {
    ...normalized,
    fingerprint: hash(normalized),
    clean: paths.length === 0,
  };
};

export const captureMainCheckoutState = async (
  repositoryRoot: string,
  options: CaptureMainCheckoutStateOptions = {},
): Promise<MainCheckoutState> => {
  try {
    return await captureMainCheckoutStateUnchecked(repositoryRoot, options);
  } catch (error) {
    if (error instanceof MigrationSafetyError) throw error;
    throw new MigrationSafetyError(
      "Main checkout could not be read safely",
      11,
      "main-checkout-unreadable",
      { cause: error },
    );
  }
};

export const assertMainCheckoutIntegrity = (
  before: MainCheckoutState,
  after: MainCheckoutState,
): void => {
  if (!before.clean || !after.clean || before.fingerprint !== after.fingerprint)
    throw new MigrationSafetyError(
      "Main checkout changed during migration execution",
      11,
      "main-checkout-mutated",
    );
};
