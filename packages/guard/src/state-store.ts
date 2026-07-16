import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArchitectureConfig,
  ArchitectureMetrics,
  GrowthModeBaselineIdentity,
  GrowthModeReport,
  GrowthModeRepositoryIdentity,
  RepositoryModel,
} from "@braid/core";
import { growthModeReportSchema } from "@braid/core";
import { canonicalJson, sha256 } from "./canonical.js";
import type { SourceManifest } from "./git-state.js";

export interface GrowthBaselineCapture {
  identity: GrowthModeBaselineIdentity;
  head: string | null;
  sourceManifest: SourceManifest;
  repository: RepositoryModel;
  metrics: ArchitectureMetrics;
  warnings: string[];
  thresholds: ArchitectureConfig["thresholds"];
}

export interface GrowthStopState {
  fingerprint: string | null;
  attempts: number;
  unresolvedCompletion: boolean;
}

export interface GrowthSessionState {
  schemaVersion: 1;
  repository: GrowthModeRepositoryIdentity;
  baseline: GrowthBaselineCapture;
  lastEvaluationFingerprint: string;
  latestReport: GrowthModeReport;
  stop: GrowthStopState;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export class GrowthStateStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(
    gitDirectory: string,
    sessionId: string,
    private readonly repository: GrowthModeRepositoryIdentity,
  ) {
    this.directory = path.join(gitDirectory, "braid", "growth-mode", "v1");
    this.filePath = path.join(this.directory, `${sha256(sessionId)}.json`);
  }

  async load(): Promise<GrowthSessionState | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("schemaVersion" in parsed) ||
      parsed.schemaVersion !== 1 ||
      !("repository" in parsed) ||
      parsed.repository === null ||
      typeof parsed.repository !== "object" ||
      !("worktreeId" in parsed.repository) ||
      parsed.repository.worktreeId !== this.repository.worktreeId ||
      !("latestReport" in parsed)
    )
      throw new Error(
        "Growth Mode session state is invalid or belongs to another worktree",
      );

    const state = parsed as GrowthSessionState;
    growthModeReportSchema.parse(state.latestReport);
    return state;
  }

  async save(state: GrowthSessionState): Promise<void> {
    if (state.repository.worktreeId !== this.repository.worktreeId)
      throw new Error(
        "Refusing to persist Growth Mode state for another worktree",
      );
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  async reset(): Promise<boolean> {
    try {
      await unlink(this.filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}
