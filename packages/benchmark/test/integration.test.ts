import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuite } from "../src/fixtures/fixture-loader.js";
import {
  defaultBraidCommand,
  runBenchmarkSuite,
} from "../src/runner/benchmark-runner.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const benchmarksRoot = path.join(workspaceRoot, "benchmarks");

describe("synthetic benchmark integration", () => {
  it("runs all proposal fixtures deterministically without source mutation", async () => {
    const run = await runBenchmarkSuite(
      await loadSuite(benchmarksRoot, "phase-2-core"),
      {
        workspaceRoot,
        benchmarksRoot,
        braidCommand: defaultBraidCommand(workspaceRoot),
        keepWorkdirs: false,
        kind: "proposal",
      },
    );
    expect(run.cases).toHaveLength(5);
    for (const result of run.cases) {
      expect(result.type).toBe("proposal");
      if (result.type !== "proposal") continue;
      expect(result.expectedIssueCoverage).toBe(1);
      expect(result.proposalValidity).toBe(1);
      expect(result.topKCoverage).toBe(1);
      expect(result.evidenceCorrectness).toBe(1);
      expect(result.deterministic).toBe(true);
      expect(result.persistenceIdempotent).toBe(true);
      expect(result.sourceMutations).toEqual([]);
    }
    expect(
      run.cases.find(({ caseId }) => caseId === "clean-modular-app"),
    ).toMatchObject({ proposals: [], unexpectedProposalIds: [] });
    expect(
      run.cases.find(({ caseId }) => caseId === "protected-cycle"),
    ).toMatchObject({
      proposals: [{ risk: { level: "high" } }],
    });
  }, 30_000);

  it("runs the before/after comparison with behavior and guardrails", async () => {
    const run = await runBenchmarkSuite(
      await loadSuite(benchmarksRoot, "static-comparison"),
      {
        workspaceRoot,
        benchmarksRoot,
        braidCommand: defaultBraidCommand(workspaceRoot),
        keepWorkdirs: false,
        kind: "static-comparison",
      },
    );
    const result = run.cases[0];
    expect(result?.type).toBe("static-comparison");
    if (!result || result.type !== "static-comparison") return;
    expect(result.behaviorValid).toBe(true);
    expect(result.after.architecture.circularDependencies).toBeLessThan(
      result.before.architecture.circularDependencies,
    );
    expect(result.after.architecture.oversizedFiles).toBeLessThan(
      result.before.architecture.oversizedFiles,
    );
    expect(result.architectureDelta.sourceLinesOfCode).toBeGreaterThan(0);
    expect(
      result.tolerances.every(({ withinTolerance }) => withinTolerance),
    ).toBe(true);
    expect(result.sourceMutations).toEqual([]);
  }, 15_000);
});
