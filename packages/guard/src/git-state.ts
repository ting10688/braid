import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { glob, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ArchitectureConfig } from "@braid/core";
import type { GrowthModeRepositoryIdentity } from "@braid/core";
import { CONFIG_FILE } from "@braid/shared";
import {
  binaryCompare,
  canonicalJson,
  portablePath,
  sha256,
} from "./canonical.js";

const execFileAsync = promisify(execFile);

const gitRaw = async (
  projectRoot: string,
  args: readonly string[],
): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

const git = async (
  projectRoot: string,
  args: readonly string[],
): Promise<string> => (await gitRaw(projectRoot, args)).trim();

const resolvedGitPath = async (
  projectRoot: string,
  gitPath: string,
): Promise<string> =>
  realpath(
    path.isAbsolute(gitPath) ? gitPath : path.resolve(projectRoot, gitPath),
  );

export interface GitContext {
  projectRoot: string;
  gitDirectory: string;
  commonGitDirectory: string;
  repository: GrowthModeRepositoryIdentity;
}

export const resolveGitContext = async (
  projectRoot: string,
): Promise<GitContext> => {
  const root = await realpath(path.resolve(projectRoot));
  const [gitDirectory, commonGitDirectory] = await Promise.all([
    git(root, ["rev-parse", "--git-dir"]),
    git(root, ["rev-parse", "--git-common-dir"]),
  ]);
  const [resolvedDirectory, resolvedCommon] = await Promise.all([
    resolvedGitPath(root, gitDirectory),
    resolvedGitPath(root, commonGitDirectory),
  ]);
  return {
    projectRoot: root,
    gitDirectory: resolvedDirectory,
    commonGitDirectory: resolvedCommon,
    repository: {
      repositoryId: sha256(`repository\0${resolvedCommon}`),
      worktreeId: sha256(`worktree\0${resolvedDirectory}`),
    },
  };
};

export type SourceManifest = Record<string, string>;

export interface GitStateCapture extends GitContext {
  head: string | null;
  configFingerprint: string;
  indexFingerprint: string;
  sourceFingerprint: string;
  gitFingerprint: string;
  sourceManifest: SourceManifest;
}

const currentHead = async (projectRoot: string): Promise<string | null> => {
  try {
    return await git(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
};

const sourceManifest = async (
  projectRoot: string,
  config: ArchitectureConfig,
): Promise<SourceManifest> => {
  const matched = new Set<string>();
  for await (const filePath of glob(config.source.include, {
    cwd: projectRoot,
    exclude: config.source.exclude,
  })) {
    const absolutePath = path.resolve(projectRoot, filePath);
    if ((await stat(absolutePath)).isFile()) matched.add(absolutePath);
  }

  const entries = await Promise.all(
    [...matched].sort(binaryCompare).map(async (absolutePath) => {
      const relative = portablePath(path.relative(projectRoot, absolutePath));
      const contents = await readFile(absolutePath);
      return [
        relative,
        createHash("sha256").update(contents).digest("hex"),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
};

const analysisConfigurationFingerprint = async (
  projectRoot: string,
  architectureConfigFingerprint: string,
): Promise<string> => {
  const files = new Set<string>();
  for await (const filePath of glob(["package.json", "tsconfig*.json"], {
    cwd: projectRoot,
  })) {
    const absolutePath = path.resolve(projectRoot, filePath);
    if ((await stat(absolutePath)).isFile()) files.add(absolutePath);
  }
  const contents = await Promise.all(
    [...files].sort(binaryCompare).map(async (absolutePath) => ({
      path: portablePath(path.relative(projectRoot, absolutePath)),
      hash: createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex"),
    })),
  );
  return sha256({ architectureConfigFingerprint, files: contents });
};

const relevantIndexDiff = async (projectRoot: string): Promise<string> =>
  gitRaw(projectRoot, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--",
    ":(glob)**/*.ts",
    ":(glob)**/*.tsx",
    ":(glob)**/*.mts",
    ":(glob)**/*.cts",
    CONFIG_FILE.replaceAll("\\", "/"),
    "package.json",
    ":(glob)tsconfig*.json",
  ]);

export const captureGitState = async (
  context: GitContext,
  config: ArchitectureConfig,
  configFingerprint: string,
): Promise<GitStateCapture> => {
  const [head, manifest, resolvedConfigFingerprint, stagedDiff] =
    await Promise.all([
      currentHead(context.projectRoot),
      sourceManifest(context.projectRoot, config),
      analysisConfigurationFingerprint(context.projectRoot, configFingerprint),
      relevantIndexDiff(context.projectRoot),
    ]);
  const sourceFingerprint = sha256(canonicalJson(manifest));
  const indexFingerprint = sha256(stagedDiff);
  const gitFingerprint = sha256({
    head,
    configFingerprint: resolvedConfigFingerprint,
    indexFingerprint,
    sourceFingerprint,
    worktreeId: context.repository.worktreeId,
  });
  return {
    ...context,
    head,
    configFingerprint: resolvedConfigFingerprint,
    indexFingerprint,
    sourceFingerprint,
    gitFingerprint,
    sourceManifest: manifest,
  };
};

export const changedManifestPaths = (
  baseline: SourceManifest,
  current: SourceManifest,
): string[] =>
  [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .filter((filePath) => baseline[filePath] !== current[filePath])
    .sort();
