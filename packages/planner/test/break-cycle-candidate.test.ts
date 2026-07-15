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
  it("suppresses the Consola-style root-only cycle artifact", () => {
    expect(
      generateMigrationProposals(
        createPlannerSnapshot({
          imports: [
            internalEdge(
              "root:constants",
              "root:types",
              "src/constants.ts",
              "src/types.ts",
            ),
            internalEdge(
              "root:types",
              "root:constants",
              "src/types.ts",
              "src/constants.ts",
            ),
          ],
        }),
        plannerConfig,
        { type: "break-cycle" },
      ),
    ).toEqual([]);
  });

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

  it("groups multiple simple traversals in one SCC into one primary with alternatives", () => {
    const first = createPlannerSnapshot({
      imports: [
        internalEdge("a", "b"),
        internalEdge("b", "a"),
        internalEdge("a", "c"),
        internalEdge("c", "a"),
      ],
    });
    const second = createPlannerSnapshot({
      imports: [...first.repository.imports].reverse(),
      files: [...first.repository.files].reverse(),
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
    });
    const firstProposal = cycleProposal(first);
    const secondProposal = cycleProposal(second);
    expect(
      generateMigrationProposals(first, plannerConfig, {
        type: "break-cycle",
      }),
    ).toHaveLength(1);
    expect(firstProposal.target).toMatchObject({
      type: "break-cycle",
      rootCauseModules: ["a", "b", "c"],
    });
    expect(firstProposal.alternatives?.length).toBeGreaterThan(0);
    expect(secondProposal.id).toBe(firstProposal.id);
    expect(secondProposal.target).toEqual(firstProposal.target);
    expect(secondProposal.alternatives).toEqual(firstProposal.alternatives);
  });

  it("keeps distinct SCC roots as distinct top-level proposals", () => {
    const proposals = generateMigrationProposals(
      createPlannerSnapshot({
        imports: [
          internalEdge("a", "b"),
          internalEdge("b", "a"),
          internalEdge("c", "d"),
          internalEdge("d", "c"),
        ],
      }),
      plannerConfig,
      { type: "break-cycle" },
    );
    expect(proposals).toHaveLength(2);
    expect(
      new Set(
        proposals.map((proposal) =>
          proposal.target.type === "break-cycle"
            ? proposal.target.rootCauseSignature
            : undefined,
        ),
      ).size,
    ).toBe(2);
  });

  it("selects the greatest simulated reduction before lexical edge order", () => {
    const proposal = cycleProposal(
      createPlannerSnapshot({
        imports: [
          internalEdge("a", "b"),
          internalEdge("b", "z"),
          internalEdge("a", "c"),
          internalEdge("c", "z"),
          internalEdge("z", "a"),
        ],
      }),
    );
    expect(proposal.target).toMatchObject({
      type: "break-cycle",
      selectedEdge: { fromModule: "z", toModule: "a" },
    });
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
