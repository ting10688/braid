import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  architectureConfigSchema,
  architectureSnapshotSchema,
  executionConfigHash,
  migrationProposalSchema,
} from "@braid/core";
import {
  evaluateExecutionReadiness,
  suggestProposalRepair,
} from "../src/index.js";
import { createMigrationFixture } from "../src/testing/notification-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixtureInput = async () => {
  const container = await mkdtemp(path.join(tmpdir(), "braid-repair-test-"));
  temporaryDirectories.push(container);
  const fixture = await createMigrationFixture(container);
  const proposal = migrationProposalSchema.parse({
    ...fixture.proposal,
    target: {
      ...fixture.proposal.target,
      approvedCompanionSymbols: undefined,
    },
  });
  return {
    fixture,
    input: {
      proposal,
      snapshot: fixture.snapshot,
      config: fixture.config,
      configHash: executionConfigHash(fixture.config),
      sourceFingerprint: fixture.snapshot.sourceFingerprint!,
    },
  };
};

describe("proposal repair suggestions", () => {
  it("produces one deterministic minimal actionable companion addition without mutating input", async () => {
    const { input } = await fixtureInput();
    const proposalBefore = JSON.stringify(input.proposal);
    const snapshotBefore = JSON.stringify(input.snapshot);

    const first = suggestProposalRepair(input);
    const repeated = suggestProposalRepair(input);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      state: "actionable",
      currentReadinessState: "not-ready",
      predictedReadinessState: "ready",
      minimal: true,
      advisory: true,
      reevaluation: { performed: true, stable: true },
      deterministicEvidence: { stable: true },
    });
    expect(first.suggestionId).toMatch(/^RS-[a-f0-9]{16}$/u);
    expect(
      first.suggestedCompanionSymbolAdditions.map(({ symbol }) => ({
        file: symbol.file,
        name: symbol.name,
      })),
    ).toEqual([
      { file: "src/orders/order-service.ts", name: "SentNotification" },
    ]);
    expect(
      first.suggestedCompanionSymbolAdditions[0]?.omissionReadinessState,
    ).toBe("not-ready");
    expect(first.remainingBlockers).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(input.snapshot.projectRoot);
    expect(JSON.stringify(input.proposal)).toBe(proposalBefore);
    expect(JSON.stringify(input.snapshot)).toBe(snapshotBefore);
    expect(evaluateExecutionReadiness(input).state).toBe("not-ready");
  });

  it("does not suggest an unnecessary already approved companion", async () => {
    const { input } = await fixtureInput();
    const proposal = migrationProposalSchema.parse({
      ...input.proposal,
      target: {
        ...input.proposal.target,
        approvedCompanionSymbols: [
          { file: "src/orders/order-service.ts", symbol: "Order" },
        ],
      },
    });
    const suggestion = suggestProposalRepair({ ...input, proposal });

    expect(suggestion.state).toBe("actionable");
    expect(suggestion.predictedReadinessState).toBe("ready-with-warnings");
    expect(
      suggestion.suggestedCompanionSymbolAdditions.map(
        ({ symbol }) => symbol.name,
      ),
    ).toEqual(["SentNotification"]);
    expect(suggestion.warnings.map(({ code }) => code)).toContain(
      "approved-companion-not-required",
    );
  });

  it("normalizes nested evidence with binary ordering instead of the host locale", async () => {
    const { input } = await fixtureInput();
    const sourceFile = "src/orders/order-service.ts";
    const snapshot = architectureSnapshotSchema.parse({
      ...input.snapshot,
      repository: {
        ...input.snapshot.repository,
        files: input.snapshot.repository.files.map((file) =>
          file.path === sourceFile
            ? {
                ...file,
                declarations: [
                  ...(file.declarations ?? []),
                  {
                    name: "zCompanion",
                    kind: "interface",
                    exported: false,
                    startLine: 100,
                    endLine: 100,
                    references: [],
                    symbolReferences: [],
                  },
                  {
                    name: "äCompanion",
                    kind: "interface",
                    exported: false,
                    startLine: 101,
                    endLine: 101,
                    references: [],
                    symbolReferences: [],
                  },
                ],
              }
            : file,
        ),
      },
    });
    const proposal = migrationProposalSchema.parse({
      ...input.proposal,
      target: {
        ...input.proposal.target,
        approvedCompanionSymbols: [
          { file: sourceFile, symbol: "äCompanion" },
          { file: sourceFile, symbol: "zCompanion" },
        ],
      },
    });

    const suggestion = suggestProposalRepair({
      ...input,
      proposal,
      snapshot,
    });

    expect(
      suggestion.currentApprovedCompanionSymbols.map(({ name }) => name),
    ).toEqual(["zCompanion", "äCompanion"]);
    expect(
      suggestion.warnings
        .filter(({ code }) => code === "approved-companion-not-required")
        .map(({ symbols }) => symbols[0]),
    ).toEqual(["zCompanion", "äCompanion"]);
  });

  it("returns unavailable for protected or legacy companion evidence", async () => {
    const { input } = await fixtureInput();
    const protectedConfig = architectureConfigSchema.parse({
      ...input.config,
      protected_paths: ["src/orders/order-service.ts"],
    });
    const protectedSuggestion = suggestProposalRepair({
      ...input,
      config: protectedConfig,
      configHash: executionConfigHash(protectedConfig),
    });
    expect(protectedSuggestion.state).toBe("unavailable");
    expect(protectedSuggestion.suggestedCompanionSymbolAdditions).toEqual([]);
    expect(
      protectedSuggestion.remainingBlockers.map(({ code }) => code),
    ).toContain("protected-companion");

    const legacySnapshot = architectureSnapshotSchema.parse({
      ...input.snapshot,
      repository: {
        ...input.snapshot.repository,
        files: input.snapshot.repository.files.map((file) => ({
          ...file,
          ...(file.declarations
            ? {
                declarations: file.declarations.map((declaration) => {
                  const legacy = { ...declaration };
                  delete legacy.symbolReferences;
                  return legacy;
                }),
              }
            : {}),
        })),
      },
    });
    const legacySuggestion = suggestProposalRepair({
      ...input,
      snapshot: legacySnapshot,
    });
    expect(legacySuggestion.state).toBe("unavailable");
    expect(legacySuggestion.suggestedCompanionSymbolAdditions).toEqual([]);
    expect(legacySuggestion.warnings.map(({ code }) => code)).toContain(
      "legacy-reference-evidence",
    );
  });

  it("labels useful additions partial when a predicted cycle remains", async () => {
    const { input } = await fixtureInput();
    const notificationFile = "src/notification/existing.ts";
    const snapshot = architectureSnapshotSchema.parse({
      ...input.snapshot,
      repository: {
        ...input.snapshot.repository,
        files: [
          ...input.snapshot.repository.files,
          {
            path: notificationFile,
            linesOfCode: 1,
            exportedSymbols: [],
            importedFiles: ["src/orders/order-service.ts"],
            isTestFile: false,
            declarations: [],
          },
        ],
        modules: [
          ...input.snapshot.repository.modules,
          {
            id: "notification",
            kind: "feature",
            paths: [notificationFile],
            fileCount: 1,
            exportedSymbolCount: 0,
            incomingDependencies: [],
            outgoingDependencies: ["orders"],
          },
        ],
        imports: [
          ...input.snapshot.repository.imports,
          {
            fromFile: notificationFile,
            toFile: "src/orders/order-service.ts",
            fromModule: "notification",
            toModule: "orders",
            kind: "internal",
            typeOnly: false,
          },
        ],
      },
    });
    const suggestion = suggestProposalRepair({ ...input, snapshot });

    expect(suggestion.state).toBe("partial");
    expect(suggestion.predictedReadinessState).toBe("not-ready");
    expect(suggestion.minimal).toBe(false);
    expect(
      suggestion.suggestedCompanionSymbolAdditions.map(
        ({ symbol }) => symbol.name,
      ),
    ).toEqual(["SentNotification"]);
    expect(suggestion.remainingBlockers.map(({ code }) => code)).toContain(
      "predicted-cycle",
    );
  });
});
