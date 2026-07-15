import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ArchitectureSnapshot, ScopeViolation } from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";

const execFileAsync = promisify(execFile);
const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export interface SafetySurfaceEntry {
  path: string;
  contentHash: string;
}

export interface SafetySurface {
  dependencyAndConfigFiles: SafetySurfaceEntry[];
  publicEntrypointFiles: SafetySurfaceEntry[];
  publicExportHash: string;
  hash: string;
}

const dependencyOrConfig = (file: string): boolean => {
  const basename = path.posix.basename(file);
  return (
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ].includes(basename) || /^tsconfig(?:\.[^.]+)*\.json$/u.test(basename)
  );
};

const entriesFor = async (
  repositoryRoot: string,
  files: readonly string[],
): Promise<SafetySurfaceEntry[]> => {
  const entries: SafetySurfaceEntry[] = [];
  for (const file of [...new Set(files)].sort(compare)) {
    try {
      entries.push({
        path: file,
        contentHash: hash(await readFile(path.join(repositoryRoot, file))),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries;
};

export const captureSafetySurface = async (input: {
  repositoryRoot: string;
  publicEntrypoints: readonly string[];
  snapshot: ArchitectureSnapshot;
}): Promise<SafetySurface> => {
  let listed: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        input.repositoryRoot,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    listed = stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replaceAll("\\", "/"));
  } catch (error) {
    throw new MigrationSafetyError(
      "Could not inspect package, configuration, and public API safety surface",
      8,
      "safety-surface-unavailable",
      { cause: error },
    );
  }
  const dependencyAndConfigFiles = await entriesFor(
    input.repositoryRoot,
    listed.filter(dependencyOrConfig),
  );
  const publicEntrypointFiles = await entriesFor(
    input.repositoryRoot,
    input.publicEntrypoints,
  );
  const sourceFiles = new Map(
    input.snapshot.repository.files.map((file) => [file.path, file]),
  );
  const publicExportHash = hash(
    JSON.stringify(
      [...new Set(input.publicEntrypoints)].sort(compare).map((file) => ({
        path: file,
        exports: [...(sourceFiles.get(file)?.exportedSymbols ?? [])].sort(
          compare,
        ),
      })),
    ),
  );
  const normalized = {
    dependencyAndConfigFiles,
    publicEntrypointFiles,
    publicExportHash,
  };
  return { ...normalized, hash: hash(JSON.stringify(normalized)) };
};

export const compareSafetySurfaces = (
  before: SafetySurface,
  after: SafetySurface,
): ScopeViolation[] => {
  const violations: ScopeViolation[] = [];
  if (
    JSON.stringify(before.dependencyAndConfigFiles) !==
    JSON.stringify(after.dependencyAndConfigFiles)
  )
    violations.push({
      code: "dependency-change",
      message:
        "Package, dependency lock, or TypeScript configuration surface changed",
    });
  if (
    JSON.stringify(before.publicEntrypointFiles) !==
      JSON.stringify(after.publicEntrypointFiles) ||
    before.publicExportHash !== after.publicExportHash
  )
    violations.push({
      code: "public-entrypoint-change",
      message: "Public entrypoint content or export surface changed",
    });
  return violations;
};
