import {
  benchmarkRunSchema,
  type BenchmarkRun,
} from "../src/models/benchmark.js";

const hash = (value: string): string => value.repeat(64).slice(0, 64);

export const benchmarkRunFixture = (
  overrides: Record<string, unknown> = {},
): BenchmarkRun =>
  benchmarkRunSchema.parse({
    schemaVersion: 1,
    runId: "suite-20260715T000000000Z",
    suiteId: "suite",
    suiteVersion: "1.0.0",
    expectationVersion: "1.0.0",
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
    braid: {
      commit: "abc1234",
      version: "0.2.0",
      command: "/Users/alice/projects/braid/bin/braid",
    },
    benchmark: { commit: "def5678", version: "0.2.0" },
    environment: {
      operatingSystem: "darwin 25.0.0",
      architecture: "arm64",
      nodeVersion: "v22.0.0",
      pnpmVersion: "11.7.0",
      gitVersion: "git version 2.50.0",
      cpuModel: "Test CPU",
      logicalCpuCount: 8,
      totalMemoryBytes: 16_000_000_000,
    },
    manifest: {
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
        command: "/Users/alice/projects/braid/bin/braid",
      },
    },
    fixtureManifest: {
      schemaVersion: 1,
      manifestVersion: "1.0.0",
      suiteId: "suite",
      suiteVersion: "1.0.0",
      fixtures: [],
      hash: hash("a"),
    },
    cases: [],
    ...overrides,
  });
