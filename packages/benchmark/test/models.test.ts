import { describe, expect, it } from "vitest";
import {
  benchmarkCaseSchema,
  benchmarkSuiteSchema,
  changeTaskBenchmarkCaseSchema,
  expectationFileSchema,
  realWorldRepositorySchema,
  rollbackBenchmarkCaseSchema,
} from "../src/models/benchmark.js";

const proposalCase = {
  type: "proposal",
  id: "clean-case",
  fixture: "fixtures/clean",
  expectationFile: "expectations/clean.json",
  braidCommands: {
    init: ["init", "."],
    analyze: ["analyze", ".", "--json"],
    propose: ["propose", ".", "--json"],
  },
  expectedExitCode: 0,
};

describe("benchmark schemas", () => {
  it("accepts a valid suite and rejects unknown case discriminators", () => {
    expect(
      benchmarkSuiteSchema.parse({
        schemaVersion: 1,
        expectationVersion: "v1",
        id: "suite",
        title: "Suite",
        description: "A suite",
        cases: [proposalCase],
        repetitions: 2,
        timeoutMs: 1000,
      }).cases,
    ).toHaveLength(1);
    expect(() =>
      benchmarkCaseSchema.parse({ ...proposalCase, type: "other" }),
    ).toThrow();
  });

  it("rejects invalid expectations and tolerances", () => {
    expect(() =>
      expectationFileSchema.parse({
        schemaVersion: 1,
        version: "v1",
        issues: [
          {
            id: "bad",
            type: "extract-module",
            requiredEvidenceTypes: [],
            notes: "",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      benchmarkCaseSchema.parse({
        type: "static-comparison",
        id: "comparison",
        beforeFixture: "before",
        afterFixture: "after",
        commands: {},
        tolerances: { artifactSizeRegressionPercent: -1 },
      }),
    ).toThrow();
  });

  it("validates scaffolded Phase C and Phase D cases", () => {
    expect(
      changeTaskBenchmarkCaseSchema.parse({
        type: "change-task",
        id: "feature-task",
        source: { kind: "fixture", fixture: "fixture" },
        taskPrompt: "Add a feature",
        allowedFiles: ["src/**"],
        forbiddenFiles: ["secrets/**"],
        validationCommands: [["pnpm", "test"]],
        architectureBudgets: { modulesTouched: 3 },
        timeoutMs: 1000,
        maximumAttempts: 2,
        expectedBehavior: ["tests pass"],
      }).maximumAttempts,
    ).toBe(2);
    expect(
      rollbackBenchmarkCaseSchema.parse({
        type: "rollback",
        id: "rollback-case",
        fixture: "fixture",
        migrationProposalId: "P-BC-12345678",
        validationCommands: [["pnpm", "test"]],
        expectedDependentMigrations: [],
        expectedRestoredTreeHashPolicy: "exact",
        allowedGeneratedStateDifferences: [".braid/state/**"],
      }).expectedRestoredTreeHashPolicy,
    ).toBe("exact");
    expect(
      realWorldRepositorySchema.parse({
        repositoryUrl: "https://example.com/repository.git",
        commitSha: "a".repeat(40),
        license: { spdxId: "MIT", reviewed: true },
        localCacheKey: "example-a",
        setupCommands: [["pnpm", "install", "--offline"]],
        buildCommands: [["pnpm", "build"]],
        testCommands: [["pnpm", "test"]],
      }).commitSha,
    ).toHaveLength(40);
  });
});
