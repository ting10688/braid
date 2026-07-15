import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  configHash,
  migrationConfigHash,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationProposal,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";
import { createSourceFingerprint } from "./source-fingerprint.js";

const execFileAsync = promisify(execFile);

export interface PreflightInput {
  repositoryRoot: string;
  proposal: MigrationProposal;
  snapshot: ArchitectureSnapshot;
  config: ArchitectureConfig;
  approval?: string;
  requireApproval: boolean;
}

export interface PreflightResult {
  baseCommit: string;
  sourceFingerprint: string;
}

const fail = (message: string, exitCode: 3 | 4 | 5, code: string): never => {
  throw new MigrationSafetyError(message, exitCode, code);
};

export const runPreflight = async (
  input: PreflightInput,
): Promise<PreflightResult> => {
  let baseCommit: string;
  let status: string;
  try {
    const [head, workingTree] = await Promise.all([
      execFileAsync("git", ["-C", input.repositoryRoot, "rev-parse", "HEAD"]),
      execFileAsync("git", [
        "-C",
        input.repositoryRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ]);
    baseCommit = head.stdout.trim();
    status = workingTree.stdout;
  } catch {
    return fail("Migration target must be a Git repository", 5, "not-git");
  }
  const dirty = status
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) =>
        !line.slice(3).replaceAll("\\", "/").startsWith(".braid/state/") &&
        !line.slice(3).replaceAll("\\", "/").startsWith(".braid/executions/"),
    );
  if (dirty.length > 0)
    fail("Migration target working tree must be clean", 5, "dirty-repository");
  if (!input.config.migration.enabled)
    fail("Migration execution is disabled in configuration", 5, "disabled");
  if (input.config.migration.validation.commands.length === 0)
    fail(
      "Migration validation commands must be configured",
      5,
      "validation-missing",
    );
  if (input.proposal.type !== "extract-module")
    fail("Phase 3 supports extract-module only", 5, "unsupported-proposal");
  if (input.proposal.risk.level !== "low")
    fail("Only low-risk proposals may execute", 5, "unsafe-risk");
  if (input.proposal.reversibility.level !== "easy")
    fail(
      "Only easy-reversibility proposals may execute",
      5,
      "unsafe-reversibility",
    );
  if (
    input.proposal.evidence.some(
      (evidence) => evidence.type === "protected-path-impact",
    )
  )
    fail("Protected paths cannot be migrated", 5, "protected-path");
  if (
    input.proposal.evidence.some(
      (evidence) => evidence.type === "public-entrypoint-impact",
    ) ||
    input.proposal.affectedFiles.some((file) =>
      input.snapshot.repository.publicEntrypoints.includes(file),
    )
  )
    fail("Public entrypoints cannot be migrated", 5, "public-entrypoint");
  if (input.proposal.snapshotId !== input.snapshot.id)
    fail(
      "Proposal does not reference the selected snapshot",
      4,
      "stale-proposal",
    );
  if (!input.snapshot.sourceFingerprint)
    fail(
      "Snapshot has no source fingerprint; rerun braid analyze and braid propose",
      4,
      "fingerprint-missing",
    );
  if (!input.snapshot.migrationConfigHash)
    fail(
      "Snapshot has no migration configuration fingerprint; rerun braid analyze and braid propose",
      4,
      "migration-config-fingerprint-missing",
    );
  if (input.snapshot.configHash !== configHash(input.config))
    fail("Configuration changed since analysis", 4, "stale-config");
  if (input.snapshot.migrationConfigHash !== migrationConfigHash(input.config))
    fail(
      "Migration configuration changed since analysis",
      4,
      "stale-migration-config",
    );
  if (input.snapshot.gitCommit && input.snapshot.gitCommit !== baseCommit)
    fail("Repository HEAD changed since analysis", 4, "stale-head");
  const currentFingerprint = await createSourceFingerprint(
    input.repositoryRoot,
  );
  if (currentFingerprint.hash !== input.snapshot.sourceFingerprint)
    fail("Source changed since analysis", 4, "stale-source");
  if (
    input.requireApproval &&
    (!input.approval || input.approval !== input.proposal.id)
  )
    fail(
      `Approval must exactly equal ${input.proposal.id}`,
      3,
      "approval-mismatch",
    );
  return { baseCommit, sourceFingerprint: currentFingerprint.hash };
};
