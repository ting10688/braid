import path from "node:path";
import { createHash } from "node:crypto";
import {
  executionConfigHash,
  migrationExecutionPlanSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationExecutionPlan,
  type MigrationProposal,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";
import { normalizeProposal } from "@braid/store";
import {
  FORBIDDEN_FILE_PATTERNS,
  MIGRATOR_VERSION,
  SCOPE_POLICY_VERSION,
} from "./safety.js";

export interface CreateExecutionPlanInput {
  proposal: MigrationProposal;
  snapshot: ArchitectureSnapshot;
  config: ArchitectureConfig;
  baseCommit: string;
  sourceFingerprint: string;
  executor?: {
    kind: "codex" | "scripted-test";
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number;
  };
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compare);

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const destinationDirectory = (
  sourceFile: string,
  sourceModule: string,
  suggestedModule: string,
): string => {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(suggestedModule))
    throw new MigrationSafetyError(
      `Unsafe suggested module name: ${suggestedModule}`,
      5,
      "unsafe-destination-module",
    );
  const directory = path.posix.dirname(sourceFile);
  const moduleSegments = sourceModule.split("/");
  const directorySegments = directory.split("/");
  const suffix = directorySegments.slice(-moduleSegments.length);
  const base =
    suffix.join("/") === moduleSegments.join("/")
      ? directorySegments.slice(0, -moduleSegments.length)
      : directorySegments.slice(0, -1);
  return [...base, suggestedModule].join("/");
};

export const createExecutionPlan = (
  input: CreateExecutionPlanInput,
): MigrationExecutionPlan => {
  if (input.proposal.target.type !== "extract-module")
    throw new MigrationSafetyError(
      "Phase 3 supports extract-module proposals only",
      5,
      "unsupported-proposal-type",
    );
  const target = input.proposal.target;
  const importers = input.snapshot.repository.imports
    .filter(
      (edge) => edge.kind === "internal" && edge.toFile === target.sourceFile,
    )
    .map((edge) => edge.fromFile);
  const referenceFiles = input.snapshot.repository.files
    .filter((file) =>
      file.declarations?.some((declaration) =>
        declaration.references.some((reference) =>
          target.candidateSymbols.includes(reference),
        ),
      ),
    )
    .map((file) => file.path);
  const allowedTestFiles = sorted(
    input.snapshot.repository.files
      .filter(
        (file) =>
          file.isTestFile &&
          (file.importedFiles.includes(target.sourceFile) ||
            importers.includes(file.path)),
      )
      .map((file) => file.path),
  );
  const allowedExistingFiles = sorted([
    ...input.proposal.affectedFiles,
    ...importers,
    ...referenceFiles,
  ]).filter((file) => !allowedTestFiles.includes(file));
  const destination = destinationDirectory(
    target.sourceFile,
    target.sourceModule,
    target.suggestedModuleName,
  );
  const executor = {
    kind: input.executor?.kind ?? ("codex" as const),
    ...(input.executor?.model ? { requestedModel: input.executor.model } : {}),
    ...(input.executor?.reasoningEffort
      ? { requestedReasoningEffort: input.executor.reasoningEffort }
      : {}),
    timeoutMs:
      input.executor?.timeoutMs ?? input.config.migration.codex.timeoutMs,
    sandbox: "workspace-write" as const,
  };
  const normalizedProposal = normalizeProposal(input.proposal);
  const proposalContentHash = createHash("sha256")
    .update(
      canonical({
        ...normalizedProposal,
        snapshotId: "<linked-snapshot>",
      }),
    )
    .digest("hex");
  const identity = {
    proposalId: normalizedProposal.id,
    proposalContentHash,
    baseCommit: input.baseCommit,
    sourceFingerprint: input.sourceFingerprint,
    configHash: executionConfigHash(input.config),
    scopePolicyVersion: SCOPE_POLICY_VERSION,
    validation: input.config.migration.validation.commands,
    executor,
    migratorVersion: MIGRATOR_VERSION,
  };
  const planId = `PL-${createHash("sha256")
    .update(canonical(identity))
    .digest("hex")
    .slice(0, 16)}`;

  return migrationExecutionPlanSchema.parse({
    schemaVersion: 1,
    planId,
    proposalId: input.proposal.id,
    proposalType: "extract-module",
    repository: {
      baseCommit: input.baseCommit,
      sourceFingerprint: input.sourceFingerprint,
      configHash: executionConfigHash(input.config),
      snapshotId: input.snapshot.id,
    },
    approval: { requiredProposalId: input.proposal.id },
    scope: {
      allowedExistingFiles,
      allowedNewFilePatterns: [`${destination}/**`],
      allowedTestFiles,
      forbiddenFiles: [...FORBIDDEN_FILE_PATTERNS],
      maximumChangedFiles: input.config.migration.maximumChangedFiles,
    },
    expectedChange: {
      sourceFile: target.sourceFile,
      sourceModule: target.sourceModule,
      suggestedModule: target.suggestedModuleName,
      destinationDirectory: destination,
      symbols: sorted(target.candidateSymbols),
      predictedImpact: input.proposal.expectedImpact,
    },
    validation: {
      commands: input.config.migration.validation.commands,
    },
    executor,
  });
};
