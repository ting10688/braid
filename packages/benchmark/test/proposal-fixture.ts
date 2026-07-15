import { migrationProposalSchema, type MigrationProposal } from "@braid/core";

export const extractionProposal = (
  id = "P-EM-12345678",
  sourceFile = "src/modules/orders/service.ts",
): MigrationProposal =>
  migrationProposalSchema.parse({
    schemaVersion: 1,
    id,
    snapshotId: "S-123456789abc-20260715T000000000Z",
    type: "extract-module",
    title: "Extract notifications",
    summary: "Independent fixture proposal",
    affectedFiles: [sourceFile],
    affectedModules: ["modules/orders"],
    target: {
      type: "extract-module",
      sourceFile,
      sourceModule: "modules/orders",
      candidateSymbols: [
        "formatNotification",
        "notificationLog",
        "retryNotification",
        "sendNotification",
      ],
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "oversized-file",
        file: sourceFile,
        actualLines: 29,
        thresholdLines: 20,
      },
      {
        type: "symbol-cluster",
        sourceFile,
        symbols: [
          "formatNotification",
          "notificationLog",
          "retryNotification",
          "sendNotification",
        ],
        sharedTokens: ["notification"],
        internalReferenceCount: 3,
      },
    ],
    expectedImpact: { simulated: [], estimated: [], unknowns: [] },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "easy", factors: ["isolated"] },
    preconditions: ["tests pass"],
    constraints: ["preserve behavior"],
    rollbackStrategy: "Revert the extraction.",
    ranking: {
      severity: 2,
      confidence: 3,
      expectedBenefit: 2,
      riskPenalty: 0,
      deterministicTieBreaker: id,
    },
  });
