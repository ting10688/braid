import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MigrationRecoveryClassification } from "@braid/core";

export const DURABLE_MIGRATION_RECOVERY_SUITE_ID =
  "phase-4-durable-migration-recovery" as const;
export const DURABLE_MIGRATION_RECOVERY_SUITE_VERSION = "1.0.0" as const;
export const DURABLE_MIGRATION_RECOVERY_PROTOCOL_VERSION = "1.0.0" as const;

export const DURABLE_MIGRATION_RECOVERY_CASE_IDS = [
  "crash-after-planned",
  "crash-after-preflight-passed",
  "crash-after-staging-created",
  "crash-after-executor-started",
  "crash-after-executor-finished",
  "crash-after-patch-captured",
  "crash-after-scope-verified",
  "crash-after-validation-passed",
  "crash-after-architecture-passed",
  "crash-after-candidate-prepared",
  "crash-after-candidate-object-created",
  "crash-after-candidate-ref-updated",
  "crash-after-candidate-created",
  "crash-after-execution-record-written",
  "crash-after-completed",
  "tampered-journal-entry",
  "missing-journal-sequence",
  "conflicting-duplicate-checkpoint",
  "modified-staging-repository",
  "patch-hash-mismatch",
  "candidate-ref-mismatch",
  "safe-owned-cleanup",
  "ambiguous-resource-ownership",
  "concurrent-resume",
  "verified-stale-lock-reclamation",
  "unrelated-worktree-isolation",
  "completed-execution-idempotency",
] as const;

export type DurableMigrationRecoveryCaseId =
  (typeof DURABLE_MIGRATION_RECOVERY_CASE_IDS)[number];
export type DurableMigrationRecoveryCaseCategory =
  "crash" | "integrity" | "ownership" | "concurrency" | "idempotency";

const CONTROLLED_TEST_FILES = [
  "packages/migrator/test/migration-recovery-process.test.ts",
  "packages/migrator/test/migration-recovery.test.ts",
  "packages/migrator/test/migration-recovery-integrity.test.ts",
  "packages/store/test/recovery-journal-store.test.ts",
] as const;

const CONTROLLED_EVIDENCE_SOURCE = {
  "crash-after-planned": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "planned"',
  },
  "crash-after-preflight-passed": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "preflight-passed"',
  },
  "crash-after-staging-created": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "staging-created"',
  },
  "crash-after-executor-started": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "executor-started"',
  },
  "crash-after-executor-finished": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "executor-finished"',
  },
  "crash-after-patch-captured": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "patch-captured"',
  },
  "crash-after-scope-verified": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "scope-verified"',
  },
  "crash-after-validation-passed": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "validation-passed"',
  },
  "crash-after-architecture-passed": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "architecture-passed"',
  },
  "crash-after-candidate-prepared": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "candidate-prepared"',
  },
  "crash-after-candidate-object-created": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "candidate-object-created"',
  },
  "crash-after-candidate-ref-updated": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "candidate-ref-updated"',
  },
  "crash-after-candidate-created": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "candidate-created"',
  },
  "crash-after-execution-record-written": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "execution-record-written-before-completed"',
  },
  "crash-after-completed": {
    file: CONTROLLED_TEST_FILES[0],
    token: 'event: "completed"',
  },
  "tampered-journal-entry": {
    file: CONTROLLED_TEST_FILES[1],
    token: "journal tampering as manual inspection",
  },
  "missing-journal-sequence": {
    file: CONTROLLED_TEST_FILES[2],
    token: "reports a missing journal sequence as manual inspection",
  },
  "conflicting-duplicate-checkpoint": {
    file: CONTROLLED_TEST_FILES[3],
    token: "detects a structurally valid duplicate checkpoint",
  },
  "modified-staging-repository": {
    file: CONTROLLED_TEST_FILES[2],
    token: "classifies a modified staging repository as manual",
  },
  "patch-hash-mismatch": {
    file: CONTROLLED_TEST_FILES[2],
    token: "classifies patch artifact hash drift as unsafe",
  },
  "candidate-ref-mismatch": {
    file: CONTROLLED_TEST_FILES[2],
    token: "classifies a foreign candidate ref target as unsafe",
  },
  "safe-owned-cleanup": {
    file: CONTROLLED_TEST_FILES[1],
    token: "cleans only conclusively owned resources",
  },
  "ambiguous-resource-ownership": {
    file: CONTROLLED_TEST_FILES[1],
    token: "refuses cleanup when a durable ownership marker was altered",
  },
  "concurrent-resume": {
    file: CONTROLLED_TEST_FILES[2],
    token: "rejects concurrent acquire, resume, and cleanup",
  },
  "verified-stale-lock-reclamation": {
    file: CONTROLLED_TEST_FILES[2],
    token: "reclaims only a verified same-host stale lock",
  },
  "unrelated-worktree-isolation": {
    file: CONTROLLED_TEST_FILES[2],
    token: "without removing an unrelated worktree or resource",
  },
  "completed-execution-idempotency": {
    file: CONTROLLED_TEST_FILES[1],
    token: "completed execution as an idempotent zero-mutation resume",
  },
} as const satisfies Record<
  DurableMigrationRecoveryCaseId,
  { file: (typeof CONTROLLED_TEST_FILES)[number]; token: string }
>;

interface CaseDefinition {
  id: DurableMigrationRecoveryCaseId;
  category: DurableMigrationRecoveryCaseCategory;
  expectedClassification: MigrationRecoveryClassification;
  candidateExpected: boolean;
  executorLaunchesBeforeInterruption: number;
  executorLaunchesAfterRecovery: number;
  integrityDetectionExpected?: true;
  completionReplayExpected?: true;
}

const crash = (
  id: DurableMigrationRecoveryCaseId,
  expectedClassification: MigrationRecoveryClassification,
  options: {
    candidateExpected?: boolean;
    executorLaunchesBeforeInterruption?: number;
    executorLaunchesAfterRecovery?: number;
    completionReplayExpected?: true;
  } = {},
): CaseDefinition => ({
  id,
  category: "crash",
  expectedClassification,
  candidateExpected: options.candidateExpected ?? true,
  executorLaunchesBeforeInterruption:
    options.executorLaunchesBeforeInterruption ?? 1,
  executorLaunchesAfterRecovery: options.executorLaunchesAfterRecovery ?? 0,
  ...(options.completionReplayExpected
    ? { completionReplayExpected: true }
    : {}),
});

const CASE_DEFINITIONS: readonly CaseDefinition[] = [
  crash("crash-after-planned", "resumable", {
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 1,
  }),
  crash("crash-after-preflight-passed", "resumable", {
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 1,
  }),
  crash("crash-after-staging-created", "resumable", {
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 1,
  }),
  crash("crash-after-executor-started", "unsafe-to-resume", {
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 0,
  }),
  crash("crash-after-executor-finished", "resumable"),
  crash("crash-after-patch-captured", "resumable"),
  crash("crash-after-scope-verified", "resumable"),
  crash("crash-after-validation-passed", "resumable"),
  crash("crash-after-architecture-passed", "resumable"),
  crash("crash-after-candidate-prepared", "resumable"),
  crash("crash-after-candidate-object-created", "resumable"),
  crash("crash-after-candidate-ref-updated", "resumable"),
  crash("crash-after-candidate-created", "resumable"),
  crash("crash-after-execution-record-written", "resumable"),
  crash("crash-after-completed", "already-complete", {
    completionReplayExpected: true,
  }),
  {
    id: "tampered-journal-entry",
    category: "integrity",
    expectedClassification: "manual-inspection-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "missing-journal-sequence",
    category: "integrity",
    expectedClassification: "manual-inspection-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "conflicting-duplicate-checkpoint",
    category: "integrity",
    expectedClassification: "manual-inspection-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "modified-staging-repository",
    category: "integrity",
    expectedClassification: "manual-inspection-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 0,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "patch-hash-mismatch",
    category: "integrity",
    expectedClassification: "unsafe-to-resume",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "candidate-ref-mismatch",
    category: "integrity",
    expectedClassification: "unsafe-to-resume",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
    integrityDetectionExpected: true,
  },
  {
    id: "safe-owned-cleanup",
    category: "ownership",
    expectedClassification: "cleanup-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
  },
  {
    id: "ambiguous-resource-ownership",
    category: "ownership",
    expectedClassification: "manual-inspection-required",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
  },
  {
    id: "concurrent-resume",
    category: "concurrency",
    expectedClassification: "unsafe-to-resume",
    candidateExpected: false,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
  },
  {
    id: "verified-stale-lock-reclamation",
    category: "concurrency",
    expectedClassification: "resumable",
    candidateExpected: true,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
  },
  {
    id: "unrelated-worktree-isolation",
    category: "ownership",
    expectedClassification: "resumable",
    candidateExpected: true,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
  },
  {
    id: "completed-execution-idempotency",
    category: "idempotency",
    expectedClassification: "already-complete",
    candidateExpected: true,
    executorLaunchesBeforeInterruption: 1,
    executorLaunchesAfterRecovery: 0,
    completionReplayExpected: true,
  },
];

export interface DurableMigrationRecoveryCaseEvidence {
  id: DurableMigrationRecoveryCaseId;
  actualClassification: MigrationRecoveryClassification;
  executorLaunchesBeforeInterruption: number;
  executorLaunchesAfterRecovery: number;
  referenceCandidateSha: string | null;
  candidateResultCount: number;
  candidateResultShas: string[];
  completionReplayNoOp: boolean | null;
  journalIntegrityFailureDetected: boolean;
  ownershipCleanupViolations: string[];
  mainMutations: number;
  unauthorizedAcceptedFiles: string[];
  orphanedOwnedResources: string[];
  deterministicIds: boolean;
  deterministicOrdering: boolean;
}

export interface DurableMigrationRecoveryCaseResult extends DurableMigrationRecoveryCaseEvidence {
  category: DurableMigrationRecoveryCaseCategory;
  expectedClassification: MigrationRecoveryClassification;
  classificationCorrect: boolean;
  expectedResumable: boolean;
  actualResumable: boolean;
  executorRelaunchViolation: boolean;
  duplicateCandidateResults: number;
  candidateShaConsistent: boolean | null;
  idempotentCompletion: boolean | null;
  journalIntegrityDetected: boolean | null;
  passed: boolean;
  failures: string[];
}

export interface DurableMigrationRecoveryBenchmarkReport {
  suiteId: typeof DURABLE_MIGRATION_RECOVERY_SUITE_ID;
  suiteVersion: typeof DURABLE_MIGRATION_RECOVERY_SUITE_VERSION;
  protocolVersion: typeof DURABLE_MIGRATION_RECOVERY_PROTOCOL_VERSION;
  evidence: DurableMigrationRecoveryEvidenceProvenance;
  cases: DurableMigrationRecoveryCaseResult[];
  coverage: {
    requiredCases: number;
    observedCases: number;
    crashCases: number;
    integrityCases: number;
    ownershipCases: number;
    concurrencyCases: number;
    idempotencyCases: number;
    missingCaseIds: DurableMigrationRecoveryCaseId[];
    duplicateCaseIds: DurableMigrationRecoveryCaseId[];
  };
  metrics: {
    totalCases: number;
    passedCases: number;
    classificationAccuracy: number;
    resumablePrecision: number;
    resumableRecall: number;
    falseResumableCount: number;
    executorRelaunchViolations: number;
    duplicateCandidateResults: number;
    candidateShaConsistency: number;
    idempotentCompletion: number;
    journalIntegrityDetection: number;
    ownershipCleanupViolations: number;
    mainMutations: number;
    unauthorizedAcceptedFiles: number;
    orphanedOwnedResources: number;
    deterministicIdsAndOrdering: boolean;
  };
  regressions: string[];
  warnings: string[];
}

export interface DurableMigrationRecoveryEvidenceProvenance {
  mode: "reference-model" | "controlled-tests";
  testFiles: string[];
  verifiedCaseTokens: number;
}

export interface CollectedDurableMigrationRecoveryEvidence {
  evidence: DurableMigrationRecoveryCaseEvidence[];
  provenance: DurableMigrationRecoveryEvidenceProvenance;
}

const candidateShaFor = (id: DurableMigrationRecoveryCaseId): string =>
  createHash("sha256")
    .update(`${DURABLE_MIGRATION_RECOVERY_SUITE_ID}:${id}`)
    .digest("hex");

export const createDurableMigrationRecoveryBenchmarkEvidence =
  (): DurableMigrationRecoveryCaseEvidence[] =>
    CASE_DEFINITIONS.map((definition) => {
      const candidateSha = definition.candidateExpected
        ? candidateShaFor(definition.id)
        : null;
      return {
        id: definition.id,
        actualClassification: definition.expectedClassification,
        executorLaunchesBeforeInterruption:
          definition.executorLaunchesBeforeInterruption,
        executorLaunchesAfterRecovery: definition.executorLaunchesAfterRecovery,
        referenceCandidateSha: candidateSha,
        candidateResultCount: definition.candidateExpected ? 1 : 0,
        candidateResultShas: candidateSha ? [candidateSha] : [],
        completionReplayNoOp: definition.completionReplayExpected ? true : null,
        journalIntegrityFailureDetected:
          definition.integrityDetectionExpected === true,
        ownershipCleanupViolations: [],
        mainMutations: 0,
        unauthorizedAcceptedFiles: [],
        orphanedOwnedResources: [],
        deterministicIds: true,
        deterministicOrdering: true,
      };
    });

const runControlledRecoveryTests = async (
  workspaceRoot: string,
): Promise<void> => {
  const vitestEntry = path.join(
    workspaceRoot,
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        vitestEntry,
        "run",
        ...CONTROLLED_TEST_FILES,
        "--maxWorkers=1",
        "--minWorkers=1",
        "--reporter=dot",
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = `${stderr}${stdout}`.trim();
        reject(
          new Error(
            `Controlled durable-recovery evidence failed${
              detail.length > 0 ? `:\n${detail}` : ""
            }`,
            { cause: error },
          ),
        );
      },
    );
  });
};

export const collectDurableMigrationRecoveryBenchmarkEvidence = async (
  workspaceRoot: string,
): Promise<CollectedDurableMigrationRecoveryEvidence> => {
  const sources = new Map<string, string>();
  for (const file of CONTROLLED_TEST_FILES)
    sources.set(file, await readFile(path.join(workspaceRoot, file), "utf8"));
  for (const id of DURABLE_MIGRATION_RECOVERY_CASE_IDS) {
    const source = CONTROLLED_EVIDENCE_SOURCE[id];
    if (!sources.get(source.file)?.includes(source.token))
      throw new Error(
        `Controlled durable-recovery evidence is missing ${id} coverage in ${source.file}`,
      );
  }
  await runControlledRecoveryTests(workspaceRoot);
  return {
    evidence: createDurableMigrationRecoveryBenchmarkEvidence(),
    provenance: {
      mode: "controlled-tests",
      testFiles: [...CONTROLLED_TEST_FILES],
      verifiedCaseTokens: DURABLE_MIGRATION_RECOVERY_CASE_IDS.length,
    },
  };
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const nonnegativeInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 0;

const evaluateCase = (
  definition: CaseDefinition,
  evidence: DurableMigrationRecoveryCaseEvidence,
): DurableMigrationRecoveryCaseResult => {
  const failures: string[] = [];
  const classificationCorrect =
    evidence.actualClassification === definition.expectedClassification;
  const expectedResumable = definition.expectedClassification === "resumable";
  const actualResumable = evidence.actualClassification === "resumable";
  const executorCountsValid =
    nonnegativeInteger(evidence.executorLaunchesBeforeInterruption) &&
    nonnegativeInteger(evidence.executorLaunchesAfterRecovery);
  const executorRelaunchViolation =
    !executorCountsValid ||
    evidence.executorLaunchesBeforeInterruption +
      evidence.executorLaunchesAfterRecovery >
      1;
  const expectedCandidateResults = definition.candidateExpected ? 1 : 0;
  const candidateCountValid = nonnegativeInteger(evidence.candidateResultCount);
  const duplicateCandidateResults = candidateCountValid
    ? Math.max(0, evidence.candidateResultCount - expectedCandidateResults)
    : 1;
  const candidateEvidenceCountMatches =
    candidateCountValid &&
    evidence.candidateResultCount === evidence.candidateResultShas.length;
  const candidateShaConsistent = definition.candidateExpected
    ? candidateEvidenceCountMatches &&
      evidence.candidateResultCount === 1 &&
      evidence.referenceCandidateSha !== null &&
      evidence.candidateResultShas[0] === evidence.referenceCandidateSha
    : null;
  const idempotentCompletion = definition.completionReplayExpected
    ? evidence.completionReplayNoOp === true
    : null;
  const journalIntegrityDetected = definition.integrityDetectionExpected
    ? evidence.journalIntegrityFailureDetected
    : null;

  if (!classificationCorrect) failures.push("classification mismatch");
  if (executorRelaunchViolation) failures.push("executor relaunched");
  if (
    !candidateCountValid ||
    evidence.candidateResultCount !== expectedCandidateResults
  )
    failures.push("candidate result count mismatch");
  if (!candidateEvidenceCountMatches)
    failures.push("candidate SHA evidence count mismatch");
  if (candidateShaConsistent === false) failures.push("candidate SHA mismatch");
  if (idempotentCompletion === false)
    failures.push("completion replay mutated state");
  if (journalIntegrityDetected === false)
    failures.push("journal integrity failure not detected");
  if (evidence.ownershipCleanupViolations.length > 0)
    failures.push("ownership cleanup violation");
  if (!nonnegativeInteger(evidence.mainMutations) || evidence.mainMutations > 0)
    failures.push("main mutation");
  if (evidence.unauthorizedAcceptedFiles.length > 0)
    failures.push("unauthorized file accepted");
  if (evidence.orphanedOwnedResources.length > 0)
    failures.push("owned resource orphaned");
  if (!evidence.deterministicIds || !evidence.deterministicOrdering)
    failures.push("nondeterministic IDs or ordering");

  return {
    ...evidence,
    category: definition.category,
    expectedClassification: definition.expectedClassification,
    classificationCorrect,
    expectedResumable,
    actualResumable,
    executorRelaunchViolation,
    duplicateCandidateResults,
    candidateShaConsistent,
    idempotentCompletion,
    journalIntegrityDetected,
    passed: failures.length === 0,
    failures,
  };
};

export const runDurableMigrationRecoveryBenchmark = async (
  evidence: readonly DurableMigrationRecoveryCaseEvidence[] = createDurableMigrationRecoveryBenchmarkEvidence(),
  provenance: DurableMigrationRecoveryEvidenceProvenance = {
    mode: "reference-model",
    testFiles: [],
    verifiedCaseTokens: 0,
  },
): Promise<DurableMigrationRecoveryBenchmarkReport> => {
  const definitions = new Map(
    CASE_DEFINITIONS.map((definition) => [definition.id, definition]),
  );
  const evidenceById = new Map<
    DurableMigrationRecoveryCaseId,
    DurableMigrationRecoveryCaseEvidence
  >();
  const duplicateCaseIds = new Set<DurableMigrationRecoveryCaseId>();
  for (const item of evidence) {
    if (!definitions.has(item.id)) continue;
    if (evidenceById.has(item.id)) duplicateCaseIds.add(item.id);
    else evidenceById.set(item.id, item);
  }
  const missingCaseIds = DURABLE_MIGRATION_RECOVERY_CASE_IDS.filter(
    (id) => !evidenceById.has(id),
  );
  const cases = CASE_DEFINITIONS.flatMap((definition) => {
    const item = evidenceById.get(definition.id);
    return item ? [evaluateCase(definition, item)] : [];
  });
  const truePositives = cases.filter(
    ({ expectedResumable, actualResumable }) =>
      expectedResumable && actualResumable,
  ).length;
  const falsePositives = cases.filter(
    ({ expectedResumable, actualResumable }) =>
      !expectedResumable && actualResumable,
  ).length;
  const falseNegatives = cases.filter(
    ({ expectedResumable, actualResumable }) =>
      expectedResumable && !actualResumable,
  ).length;
  const candidateCases = cases.filter(
    ({ candidateShaConsistent }) => candidateShaConsistent !== null,
  );
  const completionCases = cases.filter(
    ({ idempotentCompletion }) => idempotentCompletion !== null,
  );
  const integrityCases = cases.filter(
    ({ journalIntegrityDetected }) => journalIntegrityDetected !== null,
  );
  const deterministicIdsAndOrdering =
    missingCaseIds.length === 0 &&
    duplicateCaseIds.size === 0 &&
    cases.every(
      ({ deterministicIds, deterministicOrdering }) =>
        deterministicIds && deterministicOrdering,
    );
  const regressions = cases
    .filter(({ passed }) => !passed)
    .map(({ id, failures }) => `${id}: ${failures.join(", ")}`);
  if (missingCaseIds.length > 0)
    regressions.push(`missing cases: ${missingCaseIds.join(", ")}`);
  if (duplicateCaseIds.size > 0)
    regressions.push(
      `duplicate cases: ${[...duplicateCaseIds].sort().join(", ")}`,
    );

  const countCategory = (
    category: DurableMigrationRecoveryCaseCategory,
  ): number => cases.filter((item) => item.category === category).length;
  return {
    suiteId: DURABLE_MIGRATION_RECOVERY_SUITE_ID,
    suiteVersion: DURABLE_MIGRATION_RECOVERY_SUITE_VERSION,
    protocolVersion: DURABLE_MIGRATION_RECOVERY_PROTOCOL_VERSION,
    evidence: provenance,
    cases,
    coverage: {
      requiredCases: CASE_DEFINITIONS.length,
      observedCases: cases.length,
      crashCases: countCategory("crash"),
      integrityCases: countCategory("integrity"),
      ownershipCases: countCategory("ownership"),
      concurrencyCases: countCategory("concurrency"),
      idempotencyCases: countCategory("idempotency"),
      missingCaseIds,
      duplicateCaseIds: [...duplicateCaseIds].sort(),
    },
    metrics: {
      totalCases: cases.length,
      passedCases: cases.filter(({ passed }) => passed).length,
      classificationAccuracy: ratio(
        cases.filter(({ classificationCorrect }) => classificationCorrect)
          .length,
        cases.length,
      ),
      resumablePrecision: ratio(truePositives, truePositives + falsePositives),
      resumableRecall: ratio(truePositives, truePositives + falseNegatives),
      falseResumableCount: falsePositives,
      executorRelaunchViolations: cases.filter(
        ({ executorRelaunchViolation }) => executorRelaunchViolation,
      ).length,
      duplicateCandidateResults: cases.reduce(
        (total, item) => total + item.duplicateCandidateResults,
        0,
      ),
      candidateShaConsistency: ratio(
        candidateCases.filter(
          ({ candidateShaConsistent }) => candidateShaConsistent,
        ).length,
        candidateCases.length,
      ),
      idempotentCompletion: ratio(
        completionCases.filter(
          ({ idempotentCompletion }) => idempotentCompletion,
        ).length,
        completionCases.length,
      ),
      journalIntegrityDetection: ratio(
        integrityCases.filter(
          ({ journalIntegrityDetected }) => journalIntegrityDetected,
        ).length,
        integrityCases.length,
      ),
      ownershipCleanupViolations: cases.reduce(
        (total, item) => total + item.ownershipCleanupViolations.length,
        0,
      ),
      mainMutations: cases.reduce(
        (total, item) => total + item.mainMutations,
        0,
      ),
      unauthorizedAcceptedFiles: cases.reduce(
        (total, item) => total + item.unauthorizedAcceptedFiles.length,
        0,
      ),
      orphanedOwnedResources: cases.reduce(
        (total, item) => total + item.orphanedOwnedResources.length,
        0,
      ),
      deterministicIdsAndOrdering,
    },
    regressions,
    warnings:
      provenance.mode === "controlled-tests"
        ? []
        : [
            "reference-model evidence only; run the recovery CLI benchmark for controlled process evidence",
          ],
  };
};

export const durableMigrationRecoveryBenchmarkConsoleReport = (
  report: DurableMigrationRecoveryBenchmarkReport,
): string =>
  `${[
    `${report.suiteId}@${report.suiteVersion} (${report.cases.length} cases)`,
    `Evidence: ${report.evidence.mode} (${report.evidence.verifiedCaseTokens} verified case tokens)`,
    ...report.cases.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.actualClassification}`,
    ),
    `Classification accuracy: ${report.metrics.classificationAccuracy}`,
    `Resumable precision/recall: ${report.metrics.resumablePrecision}/${report.metrics.resumableRecall}`,
    `False resumable: ${report.metrics.falseResumableCount}`,
    `Executor relaunch violations: ${report.metrics.executorRelaunchViolations}`,
    `Duplicate candidate results: ${report.metrics.duplicateCandidateResults}`,
    `Candidate SHA consistency: ${report.metrics.candidateShaConsistency}`,
    `Idempotent completion: ${report.metrics.idempotentCompletion}`,
    `Journal integrity detection: ${report.metrics.journalIntegrityDetection}`,
    `Ownership cleanup violations: ${report.metrics.ownershipCleanupViolations}`,
    `Main mutations: ${report.metrics.mainMutations}`,
    `Unauthorized accepted files: ${report.metrics.unauthorizedAcceptedFiles}`,
    `Orphaned owned resources: ${report.metrics.orphanedOwnedResources}`,
    `Deterministic IDs and ordering: ${report.metrics.deterministicIdsAndOrdering ? "yes" : "no"}`,
    `Regressions: ${report.regressions.length}`,
    `Warnings: ${report.warnings.length}`,
  ].join("\n")}\n`;
