import { describe, expect, it } from "vitest";
import { compareBenchmarkSummaries } from "../src/evaluators/iteration-comparator.js";
import {
  regressionPolicySchema,
  runManifestSchema,
  type BenchmarkSummary,
  type RegressionPolicy,
  type RunManifest,
} from "../src/models/benchmark.js";

const hash = (value: string): string => value.repeat(64).slice(0, 64);

const manifest = (overrides: Record<string, unknown> = {}): RunManifest =>
  runManifestSchema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0.0",
    suiteId: "suite",
    suiteVersion: "1.0.0",
    expectationVersion: "1.0.0",
    fixtureManifestVersion: "1.0.0",
    fixtureManifestHash: hash("a"),
    configurationHash: hash("b"),
    braidVersion: "0.2.0",
    braidCommit: "abc1234",
    benchmarkVersion: "0.2.0",
    benchmarkCommit: "def5678",
    environment: {
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "v22.0.0",
      pnpmVersion: "11.7.0",
      gitVersion: "git version 2.50.0",
    },
    execution: {
      correctnessRepetitions: 3,
      timingRepetitions: 7,
      warmupRuns: 1,
      timeoutMs: 30_000,
      command: "braid",
    },
    ...overrides,
  });

const summary = (
  correctness: Record<string, number | boolean | string> = {},
  stability: Record<string, number | boolean | string> = {},
  cost: Record<string, number | boolean | string> = {},
): BenchmarkSummary => ({
  correctness: { expectedIssueCoverage: 1, ...correctness },
  stability: { flakyCases: 0, ...stability },
  cost: { medianRuntimeMs: 100, ...cost },
});

const policy = (
  blocking: Record<string, unknown> = {
    expectedIssueCoverage: { direction: "nondecreasing" },
    flakyCases: { maximum: 0 },
  },
  warnings: Record<string, unknown> = {
    medianRuntimeMs: { allowedRegressionPercent: 20 },
  },
): RegressionPolicy =>
  regressionPolicySchema.parse({
    schemaVersion: 1,
    policyVersion: "1.0.0",
    blocking,
    warnings,
  });

const compare = (
  baselineManifest: RunManifest,
  candidateManifest: RunManifest,
  baselineSummary = summary(),
  candidateSummary = summary(),
  rules = policy(),
  allowIncompatible = false,
) =>
  compareBenchmarkSummaries(
    { runId: "baseline", manifest: baselineManifest, summary: baselineSummary },
    {
      runId: "candidate",
      manifest: candidateManifest,
      summary: candidateSummary,
    },
    rules,
    allowIncompatible,
  );

describe("iteration compatibility", () => {
  it("accepts identical manifests", () => {
    const result = compare(manifest(), manifest());
    expect(result.compatible).toBe(true);
    expect(result.overallResult).toBe("pass");
  });

  it.each([
    ["suite version", { suiteVersion: "2.0.0" }],
    ["expectation version", { expectationVersion: "2.0.0" }],
    ["fixture content", { fixtureManifestHash: hash("c") }],
    ["configuration", { configurationHash: hash("d") }],
  ])("marks changed %s as incompatible", (_, changed) => {
    const result = compare(manifest(), manifest(changed));
    expect(result.compatible).toBe(false);
    expect(result.overallResult).toBe("incompatible");
    expect(result.incompatibilities.join(" ")).toContain(
      Object.keys(changed)[0],
    );
  });

  it("keeps incompatibilities visible with the override", () => {
    const result = compare(
      manifest(),
      manifest({ suiteVersion: "2.0.0" }),
      summary(),
      summary(),
      policy(),
      true,
    );
    expect(
      result.comparisons.some(({ metric }) => metric === "compatibility"),
    ).toBe(true);
    expect(result.comparisons.length).toBeGreaterThan(1);
    expect(result.overallResult).toBe("incompatible");
  });

  it("allows correctness but warns about timing across environments", () => {
    const baseline = manifest();
    const candidate = manifest({
      environment: { ...baseline.environment, architecture: "x64" },
    });
    const result = compare(baseline, candidate);
    expect(result.compatible).toBe(true);
    expect(result.environmentWarnings).toEqual(["architecture: arm64 != x64"]);
    expect(
      result.comparisons.find(
        ({ metric }) => metric === "expectedIssueCoverage",
      )?.status,
    ).toBe("unchanged");
    expect(
      result.comparisons.find(({ metric }) => metric === "medianRuntimeMs")
        ?.status,
    ).toBe("warning");
  });
});

describe("regression policy", () => {
  it("classifies blocking regressions with an explicit rationale", () => {
    const result = compare(
      manifest(),
      manifest(),
      summary({ expectedIssueCoverage: 1 }),
      summary({ expectedIssueCoverage: 0.5 }),
    );
    const metric = result.comparisons.find(
      ({ metric }) => metric === "expectedIssueCoverage",
    );
    expect(metric).toMatchObject({ status: "regressed" });
    expect(metric?.rationale).toContain("nondecreasing");
    expect(result.overallResult).toBe("fail");
  });

  it("classifies runtime regressions as warnings", () => {
    const result = compare(
      manifest(),
      manifest(),
      summary({}, {}, { medianRuntimeMs: 100 }),
      summary({}, {}, { medianRuntimeMs: 130 }),
    );
    expect(
      result.comparisons.find(({ metric }) => metric === "medianRuntimeMs"),
    ).toMatchObject({ status: "warning" });
    expect(result.overallResult).toBe("warning");
  });

  it("classifies improvement and unchanged values", () => {
    const result = compare(
      manifest(),
      manifest(),
      summary({ expectedIssueCoverage: 0.5 }),
      summary({ expectedIssueCoverage: 1 }),
    );
    expect(
      result.comparisons.find(
        ({ metric }) => metric === "expectedIssueCoverage",
      )?.status,
    ).toBe("improved");
    expect(
      result.comparisons.find(({ metric }) => metric === "flakyCases")?.status,
    ).toBe("unchanged");
  });

  it("reports every rule affecting the same metric", () => {
    const rules = policy(
      {
        expectedIssueCoverage: [
          { direction: "nondecreasing" },
          { requiredValue: 1 },
        ],
      },
      {},
    );
    const result = compare(
      manifest(),
      manifest(),
      summary({ expectedIssueCoverage: 1 }),
      summary({ expectedIssueCoverage: 0.9 }),
      rules,
    );
    const rationale = result.comparisons.find(
      ({ metric }) => metric === "expectedIssueCoverage",
    )?.rationale;
    expect(rationale).toContain("nondecreasing");
    expect(rationale).toContain("requiredValue=1");
  });
});
