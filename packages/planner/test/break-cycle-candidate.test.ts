import { describe, expect, it } from "vitest";
import type { ArchitectureSnapshot } from "@braid/core";
import { generateMigrationProposals } from "../src/index.js";
import {
  createPlannerSnapshot,
  internalEdge,
  plannerConfig,
} from "./fixture.js";

const cycleProposal = (snapshot: ArchitectureSnapshot) =>
  generateMigrationProposals(snapshot, plannerConfig, {
    type: "break-cycle",
  })[0]!;

describe("break-cycle proposal generation", () => {
  it("handles a canonical two-module cycle with a stable edge", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [internalEdge("b", "a"), internalEdge("a", "b")],
      }),
    );

    expect(proposal.target).toMatchObject({
      type: "break-cycle",
      cycleModules: ["a", "b"],
      selectedEdge: { fromModule: "a", toModule: "b" },
    });
    expect(proposal.expectedImpact.simulated[0]).toMatchObject({
      metric: "circularDependencies",
      delta: -1,
    });
  });

  it("handles a three-module cycle and exposes long-cycle risk", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [
          internalEdge("c", "a"),
          internalEdge("b", "c"),
          internalEdge("a", "b"),
        ],
      }),
    );
    expect(proposal.risk.factors.map((factor) => factor.type)).toContain(
      "long-cycle",
    );
    expect(
      proposal.evidence.find(
        (evidence) => evidence.type === "dependency-cycle",
      ),
    ).toMatchObject({ modules: ["a", "b", "c"] });
  });

  it("groups multiple file edges and selects the lowest coupling edge", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [
          internalEdge("a", "b", "src/a/one.ts", "src/b/b.ts"),
          internalEdge("a", "b", "src/a/two.ts", "src/b/b.ts"),
          internalEdge("b", "a", "src/b/b.ts", "src/a/one.ts"),
        ],
      }),
    );
    expect(proposal.target).toMatchObject({
      type: "break-cycle",
      selectedEdge: { fromModule: "b", toModule: "a" },
    });
    expect(proposal.affectedFiles).toEqual([
      "src/a/one.ts",
      "src/a/two.ts",
      "src/b/b.ts",
    ]);
  });

  it("prefers an edge without public entrypoint involvement", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [
          internalEdge("a", "b"),
          internalEdge("b", "c"),
          internalEdge("c", "a"),
        ],
        publicEntrypoints: ["src/a/a.ts"],
      }),
    );
    expect(proposal.target).toMatchObject({
      type: "break-cycle",
      selectedEdge: { fromModule: "b", toModule: "c" },
    });
    expect(
      proposal.evidence.some(
        (evidence) => evidence.type === "public-entrypoint-impact",
      ),
    ).toBe(true);
  });

  it("makes protected-path involvement high risk and difficult to reverse", () => {
    const config = { ...plannerConfig, protected_paths: ["src/b/**"] };
    const proposal = generateMigrationProposals(
      createPlannerSnapshot({
        imports: [internalEdge("a", "b"), internalEdge("b", "a")],
      }),
      config,
      { type: "break-cycle" },
    )[0]!;
    expect(proposal.risk.level).toBe("high");
    expect(proposal.reversibility.level).toBe("difficult");
    expect(
      proposal.evidence.some(
        (evidence) => evidence.type === "protected-path-impact",
      ),
    ).toBe(true);
  });

  it("reports exact simulated reduction when one edge breaks two cycles", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [
          internalEdge("a", "b"),
          internalEdge("b", "a"),
          internalEdge("b", "c"),
          internalEdge("c", "a"),
        ],
      }),
    );
    expect(proposal.expectedImpact.simulated[0]?.delta).toBe(-2);
  });

  it("keeps tie-breaking and identity stable across reordered facts", () => {
    const first = createPlannerSnapshot({
      imports: [internalEdge("a", "b"), internalEdge("b", "a")],
    });
    const second = createPlannerSnapshot({
      imports: [...first.repository.imports].reverse(),
      files: [...first.repository.files].reverse(),
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
    });
    const firstProposal = cycleProposal(first);
    const secondProposal = cycleProposal(second);
    expect(secondProposal.id).toBe(firstProposal.id);
    expect(secondProposal.target).toEqual(firstProposal.target);
  });
});
