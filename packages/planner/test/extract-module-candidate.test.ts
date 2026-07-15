import { describe, expect, it } from "vitest";
import type { SourceFileRecord } from "@braid/core";
import { generateMigrationProposals } from "../src/index.js";
import { tokenizeSymbolName } from "../src/candidates/symbol-tokenizer.js";
import { createPlannerSnapshot, plannerConfig } from "./fixture.js";

const oversizedFile = (): SourceFileRecord => ({
  path: "src/orders/order-service.ts",
  linesOfCode: 600,
  exportedSymbols: ["buildNotification", "sendNotification", "billingTotal"],
  importedFiles: [],
  isTestFile: false,
  declarations: [
    {
      name: "sendNotification",
      kind: "function",
      exported: true,
      startLine: 10,
      endLine: 20,
      references: ["buildNotification"],
    },
    {
      name: "buildNotification",
      kind: "function",
      exported: true,
      startLine: 22,
      endLine: 30,
      references: [],
    },
    {
      name: "billingTotal",
      kind: "variable",
      exported: true,
      startLine: 40,
      endLine: 45,
      references: [],
    },
  ],
});

const extractProposal = (
  file: SourceFileRecord,
  publicEntrypoints: string[] = [],
) =>
  generateMigrationProposals(
    createPlannerSnapshot({ files: [file], publicEntrypoints }),
    plannerConfig,
    { type: "extract-module" },
  )[0];

describe("extract-module proposal generation", () => {
  it("selects a coherent notification cluster and excludes unrelated declarations", () => {
    const proposal = extractProposal(oversizedFile())!;
    expect(proposal.target).toEqual({
      type: "extract-module",
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      candidateSymbols: ["buildNotification", "sendNotification"],
      suggestedModuleName: "notification",
    });
    expect(proposal.expectedImpact.simulated).toEqual([]);
    expect(proposal.expectedImpact.unknowns).toContain(
      "Exact cross-module import changes depend on caller rewrites.",
    );
    expect(proposal.risk).toMatchObject({ level: "low", points: 0 });
    expect(proposal.reversibility.level).toBe("easy");
  });

  it("returns no proposal without a meaningful cluster", () => {
    const file = oversizedFile();
    file.declarations = file.declarations?.map((declaration, index) => ({
      ...declaration,
      name: ["alpha", "beta", "gamma"][index]!,
      references: [],
    }));
    expect(extractProposal(file)).toBeUndefined();
  });

  it("tokenizes camelCase and PascalCase and filters generic words", () => {
    expect(tokenizeSymbolName("buildNotificationPayload")).toEqual([
      "notification",
      "payload",
    ]);
    expect(tokenizeSymbolName("NotificationServiceManager")).toEqual([
      "notification",
    ]);
    expect(tokenizeSymbolName("service_manager-helper")).toEqual([]);
  });

  it("excludes tests, declarations, generated files, and index barrels", () => {
    for (const patch of [
      { isTestFile: true },
      { path: "src/orders/order-service.d.ts" },
      { path: "src/generated/order-service.ts" },
      { path: "src/orders/index.ts" },
    ])
      expect(extractProposal({ ...oversizedFile(), ...patch })).toBeUndefined();
  });

  it("records public entrypoint impact", () => {
    const file = oversizedFile();
    const proposal = extractProposal(file, [file.path])!;
    expect(proposal.risk).toMatchObject({ level: "medium", points: 2 });
    expect(proposal.reversibility.level).toBe("conditional");
    expect(
      proposal.evidence.some(
        (evidence) => evidence.type === "public-entrypoint-impact",
      ),
    ).toBe(true);
  });

  it("keeps protected extraction visible but high risk", () => {
    const file = oversizedFile();
    const proposal = generateMigrationProposals(
      createPlannerSnapshot({ files: [file] }),
      { ...plannerConfig, protected_paths: ["src/orders/**"] },
      { type: "extract-module" },
    )[0]!;
    expect(proposal.risk).toMatchObject({ level: "high", points: 5 });
    expect(proposal.reversibility.level).toBe("difficult");
    expect(proposal.risk.points).toBe(
      proposal.risk.factors.reduce((sum, factor) => sum + factor.points, 0),
    );
  });

  it("keeps destination, identity, and proposal count stable", () => {
    const first = oversizedFile();
    const second = {
      ...first,
      exportedSymbols: [...first.exportedSymbols].reverse(),
      declarations: [...first.declarations!].reverse(),
    };
    const firstProposals = generateMigrationProposals(
      createPlannerSnapshot({ files: [first] }),
      plannerConfig,
      { type: "extract-module" },
    );
    const secondProposals = generateMigrationProposals(
      createPlannerSnapshot({
        files: [second],
        createdAt: new Date("2026-07-16T00:00:00.000Z"),
      }),
      plannerConfig,
      { type: "extract-module" },
    );
    expect(firstProposals).toHaveLength(1);
    expect(secondProposals[0]?.id).toBe(firstProposals[0]?.id);
    expect(secondProposals[0]?.target).toEqual(firstProposals[0]?.target);
  });
});
