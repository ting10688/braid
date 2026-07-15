import { describe, expect, it } from "vitest";
import {
  benchmarkCaseSchema,
  benchmarkSuiteSchema,
  changeTaskBenchmarkCaseSchema,
  expectationFileSchema,
  realWorldRepositorySchema,
  repositoryManifestSchema,
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
        suiteVersion: "1.0.0",
        expectationVersion: "1.0.0",
        id: "suite",
        title: "Suite",
        description: "A suite",
        cases: [proposalCase],
        execution: { correctnessRepetitions: 2, timeoutMs: 1000 },
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

  it("requires canonical GitHub URLs, full SHAs, and explicit qualification", () => {
    const manifest = {
      schemaVersion: 1,
      id: "example",
      title: "Example",
      role: "control",
      repository: {
        url: "https://github.com/example/project.git",
        commit: "a".repeat(40),
      },
      license: {
        spdxId: "MIT",
        file: "LICENSE",
        contentHash: "b".repeat(64),
        attribution: "Example",
      },
      packageManager: {
        name: "npm",
        version: "1",
        lockfile: "package-lock.json",
        lockfileHash: "c".repeat(64),
      },
      environment: { node: ">=20", networkRequiredAfterCheckout: false },
      source: {
        include: ["src/**/*.ts"],
        exclude: [],
        tests: ["tests/**/*.test.ts"],
        testExclude: [],
        manifestHash: "d".repeat(64),
        fileCount: 1,
        testFileCount: 1,
        linesOfCode: 1,
        moduleCount: 1,
        preferredRange: "below",
        largestFiles: [{ path: "src/index.ts", linesOfCode: 1 }],
      },
      braidConfiguration: {
        file: "braid-config.yaml",
        hash: "e".repeat(64),
      },
      commands: {
        install: { executable: "npm", arguments: ["ci", "--ignore-scripts"] },
        build: { executable: "npm", arguments: ["run", "build"] },
        test: { executable: "npm", arguments: ["test"] },
      },
      qualification: {
        status: "qualified-with-limitations",
        reviewedAt: "2026-07-15",
        install: { status: "passed", command: "npm ci", detail: "passed" },
        build: { status: "passed", command: "npm run build", detail: "passed" },
        test: { status: "passed", command: "npm test", detail: "passed" },
        braidAnalysis: { status: "passed", command: "braid", detail: "passed" },
        limitations: ["Optional runtime excluded."],
      },
    };
    expect(repositoryManifestSchema.parse(manifest).qualification.status).toBe(
      "qualified-with-limitations",
    );
    expect(
      repositoryManifestSchema.parse({
        ...manifest,
        qualification: { ...manifest.qualification, status: "rejected" },
      }).qualification.status,
    ).toBe("rejected");
    expect(() =>
      repositoryManifestSchema.parse({
        ...manifest,
        repository: { ...manifest.repository, commit: "a".repeat(39) },
      }),
    ).toThrow();
    expect(() =>
      repositoryManifestSchema.parse({
        ...manifest,
        repository: {
          ...manifest.repository,
          url: "git@github.com:example/project.git",
        },
      }),
    ).toThrow();
  });
});
