import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeRepository } from "@braid/analyzer";
import { createSourceFingerprint } from "@braid/migrator";
import {
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  configHash,
  createArchitectureSnapshot,
  loadArchitectureConfig,
  migrationConfigHash,
} from "@braid/core";
import { CONFIG_FILE } from "@braid/shared";
import { JsonSnapshotStore } from "@braid/store";
import { formatConsoleReport } from "../output/console-reporter.js";

const execFileAsync = promisify(execFile);

export interface AnalyzeOptions {
  json?: boolean;
  save?: boolean;
}

const readGitCommit = async (projectRoot: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      projectRoot,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export interface CurrentSnapshot {
  snapshot: ArchitectureSnapshot;
  warnings: string[];
}

export const createCurrentSnapshot = async (
  projectRoot: string,
  config: ArchitectureConfig,
): Promise<CurrentSnapshot> => {
  const [analysis, gitCommit] = await Promise.all([
    analyzeRepository(projectRoot, config),
    readGitCommit(projectRoot),
  ]);
  const sourceFingerprint = gitCommit
    ? (await createSourceFingerprint(projectRoot)).hash
    : undefined;
  return {
    snapshot: createArchitectureSnapshot({
      projectRoot,
      gitCommit,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
      repository: analysis.repository,
      metrics: analysis.metrics,
    }),
    warnings: analysis.warnings,
  };
};

export const analyzeCommand = async (
  targetPath: string,
  options: AnalyzeOptions,
): Promise<void> => {
  const projectRoot = path.resolve(targetPath);
  const config = await loadArchitectureConfig(
    path.join(projectRoot, CONFIG_FILE),
  );
  const { snapshot, warnings } = await createCurrentSnapshot(
    projectRoot,
    config,
  );
  const savedPath =
    options.save === false
      ? null
      : await new JsonSnapshotStore(projectRoot).save(snapshot);

  for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : `${formatConsoleReport(snapshot, savedPath)}\n`,
  );
};
