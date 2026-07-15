import { describe, expect, it } from "vitest";
import { generateMigrationProposals } from "../src/index.js";
import {
  createPlannerSnapshot,
  internalEdge,
  plannerConfig,
} from "./fixture.js";

describe("proposal generator", () => {
  it("ranks critical cycles before extraction and applies filters and limits", () => {
    const snapshot = createPlannerSnapshot({
      files: [
        {
          path: "src/a/a.ts",
          linesOfCode: 600,
          exportedSymbols: ["sendNotice", "buildNotice", "unrelated"],
          importedFiles: ["src/b/b.ts"],
          isTestFile: false,
          declarations: [
            {
              name: "sendNotice",
              kind: "function",
              exported: true,
              startLine: 1,
              endLine: 10,
              references: ["buildNotice"],
            },
            {
              name: "buildNotice",
              kind: "function",
              exported: true,
              startLine: 12,
              endLine: 20,
              references: [],
            },
            {
              name: "unrelated",
              kind: "variable",
              exported: true,
              startLine: 30,
              endLine: 31,
              references: [],
            },
          ],
        },
        {
          path: "src/b/b.ts",
          linesOfCode: 10,
          exportedSymbols: [],
          importedFiles: ["src/a/a.ts"],
          isTestFile: false,
          declarations: [],
        },
      ],
      imports: [internalEdge("a", "b"), internalEdge("b", "a")],
    });
    const proposals = generateMigrationProposals(snapshot, plannerConfig);
    expect(proposals.map((proposal) => proposal.type)).toEqual([
      "break-cycle",
      "extract-module",
    ]);
    expect(
      generateMigrationProposals(snapshot, plannerConfig, { limit: 1 }),
    ).toHaveLength(1);
    expect(
      generateMigrationProposals(snapshot, plannerConfig, {
        type: "extract-module",
      }).every((proposal) => proposal.type === "extract-module"),
    ).toBe(true);
  });

  it("suppresses high-risk proposals only when configured", () => {
    const snapshot = createPlannerSnapshot({
      imports: [internalEdge("a", "b"), internalEdge("b", "a")],
    });
    const config = {
      ...plannerConfig,
      protected_paths: ["src/**"],
      planner: { ...plannerConfig.planner, include_high_risk: false },
    };
    expect(generateMigrationProposals(snapshot, config)).toEqual([]);
  });

  it("supports old snapshots without declaration facts through cycle proposals", () => {
    const proposals = generateMigrationProposals(
      createPlannerSnapshot({
        imports: [internalEdge("a", "b"), internalEdge("b", "a")],
      }),
      plannerConfig,
    );
    expect(proposals.map((proposal) => proposal.type)).toEqual(["break-cycle"]);
  });

  it("preserves Phase 2 proposal IDs when readiness reference facts are added", () => {
    const snapshot = createPlannerSnapshot({
      files: [
        {
          path: "src/orders/service.ts",
          linesOfCode: 600,
          exportedSymbols: ["sendNotification", "buildNotification"],
          importedFiles: [],
          isTestFile: false,
          declarations: [
            {
              name: "sendNotification",
              kind: "function",
              exported: true,
              startLine: 1,
              endLine: 20,
              references: ["buildNotification"],
            },
            {
              name: "buildNotification",
              kind: "function",
              exported: true,
              startLine: 22,
              endLine: 40,
              references: [],
            },
            {
              name: "placeOrder",
              kind: "function",
              exported: true,
              startLine: 42,
              endLine: 60,
              references: [],
            },
          ],
        },
      ],
    });
    const withReadinessFacts = {
      ...snapshot,
      repository: {
        ...snapshot.repository,
        files: snapshot.repository.files.map((file) => ({
          ...file,
          declarations: file.declarations?.map((declaration) => ({
            ...declaration,
            symbolReferences: declaration.references.map((name) => ({
              name,
              resolution: "local" as const,
              declarationFile: file.path,
            })),
          })),
        })),
      },
    };

    expect(
      generateMigrationProposals(withReadinessFacts, plannerConfig).map(
        ({ id }) => id,
      ),
    ).toEqual(
      generateMigrationProposals(snapshot, plannerConfig).map(({ id }) => id),
    );
  });
});
