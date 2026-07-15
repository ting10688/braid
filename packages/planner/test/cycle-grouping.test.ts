import { describe, expect, it } from "vitest";
import { migrationProposalSchema, type MigrationProposal } from "@braid/core";
import { groupCycleProposals } from "../src/proposal-generator.js";

interface CycleProposalInput {
  id: string;
  signature: string;
  title: string;
  from: string;
  to: string;
  modules?: string[];
  files?: string[];
  selectedFiles?: string[];
  delta?: number;
}

const proposal = ({
  id,
  signature,
  title,
  from,
  to,
  modules = [from, to],
  files = [`src/${from}.ts`, `src/${to}.ts`],
  selectedFiles = [`src/${from}.ts`, `src/${to}.ts`],
  delta = -1,
}: CycleProposalInput): MigrationProposal =>
  migrationProposalSchema.parse({
    schemaVersion: 1,
    id,
    snapshotId: "S-test",
    type: "break-cycle",
    title,
    summary: "Static cycle action.",
    affectedFiles: files,
    affectedModules: modules,
    target: {
      type: "break-cycle",
      cycleModules: modules,
      cycleFiles: files,
      selectedEdge: { fromModule: from, toModule: to, files: selectedFiles },
      suggestedStrategy: "introduce-boundary",
      rootCauseSignature: signature,
      rootCauseModules: [...new Set(modules)].sort(),
    },
    evidence: [
      { type: "dependency-cycle", modules, files },
      {
        type: "cycle-edge",
        fromModule: from,
        toModule: to,
        importingFiles: [selectedFiles[0]],
        importCount: 1,
      },
    ],
    expectedImpact: {
      simulated: [
        {
          metric: "circularDependencies",
          direction: "decrease",
          delta,
          rationale: `Remove ${from} to ${to}.`,
        },
      ],
      estimated: [],
      unknowns: [],
    },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "conditional", factors: ["Restore edge."] },
    preconditions: ["Edge exists."],
    constraints: ["Preserve behavior."],
    rollbackStrategy: "Restore edge.",
    ranking: {
      severity: 3,
      confidence: 3,
      expectedBenefit: 3,
      riskPenalty: 0,
      deterministicTieBreaker: id,
    },
  });

describe("cycle proposal grouping and duplicate suppression", () => {
  it("suppresses equivalent traversals and the strictly broader duplicate", () => {
    const narrow = proposal({
      id: "P-BC-00000001",
      signature: "CR-111111111111",
      title: "Narrow action",
      from: "a",
      to: "b",
    });
    const broad = proposal({
      id: "P-BC-00000002",
      signature: "CR-111111111111",
      title: "Different title, same root action",
      from: "a",
      to: "b",
      modules: ["a", "b", "c"],
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    const grouped = groupCycleProposals([broad, narrow]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.id).toBe(narrow.id);
    expect(grouped[0]?.alternatives).toBeUndefined();
  });

  it("keeps a non-equivalent action as a deterministic alternative", () => {
    const first = proposal({
      id: "P-BC-00000003",
      signature: "CR-222222222222",
      title: "First",
      from: "a",
      to: "b",
      delta: -2,
    });
    const second = proposal({
      id: "P-BC-00000004",
      signature: "CR-222222222222",
      title: "Second",
      from: "b",
      to: "a",
    });
    expect(groupCycleProposals([second, first])).toEqual(
      groupCycleProposals([first, second]),
    );
    expect(groupCycleProposals([first, second])).toHaveLength(1);
    expect(groupCycleProposals([first, second])[0]?.alternatives).toHaveLength(
      1,
    );
  });

  it("retains independent roots even when their titles and modules overlap", () => {
    const first = proposal({
      id: "P-BC-00000005",
      signature: "CR-333333333333",
      title: "Same title",
      from: "a",
      to: "b",
    });
    const second = proposal({
      id: "P-BC-00000006",
      signature: "CR-444444444444",
      title: "Same title",
      from: "a",
      to: "c",
    });
    expect(groupCycleProposals([first, second])).toHaveLength(2);
  });
});
