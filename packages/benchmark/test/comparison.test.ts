import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StaticComparisonCase } from "../src/models/benchmark.js";
import { runCommand, timingSummary } from "../src/runner/command-runner.js";
import { runComparisonCase } from "../src/runner/comparison-runner.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const benchmarksRoot = path.join(workspaceRoot, "benchmarks");
const baseCase: StaticComparisonCase = {
  type: "static-comparison",
  id: "notification-app",
  beforeFixture: "fixtures/templates/notification-app/before",
  afterFixture: "fixtures/templates/notification-app/after-manual",
  commands: {},
  smoke: true,
};

const options = {
  benchmarksRoot,
  workspaceRoot,
  correctnessRepetitions: 2,
  timingRepetitions: 1,
  warmupRuns: 1,
  timeoutMs: 10_000,
  keepWorkdirs: false,
};

describe("static comparison", () => {
  it("reports architecture separately and permits LOC increases without commands", async () => {
    const result = await runComparisonCase(baseCase, options);
    expect(result.behaviorValid).toBe(true);
    expect(result.architectureDelta.circularDependencies).toBe(-1);
    expect(result.architectureDelta.sourceLinesOfCode).toBeGreaterThan(0);
    expect(result.before.build).toBeNull();
    expect(result.after.runtimeBenchmark).toBeNull();
  });

  it("invalidates a comparison when the after build fails", async () => {
    const result = await runComparisonCase(
      {
        ...baseCase,
        commands: {
          build: [
            "node",
            "-e",
            "process.exit(require('node:fs').existsSync('src/modules/notifications/service.ts') ? 1 : 0)",
          ],
        },
      },
      options,
    );
    expect(result.before.build?.exitCodes).toEqual([0, 0]);
    expect(result.after.build?.exitCodes).toEqual([1, 1]);
    expect(result.behaviorValid).toBe(false);
  });

  it("calculates duration medians and enforces command timeouts", async () => {
    expect(timingSummary([9, 1, 5, 3])).toMatchObject({
      medianMs: 4,
      minimumMs: 1,
      maximumMs: 9,
      repetitions: 4,
    });
    const timedOut = await runCommand(
      ["node", "-e", "setTimeout(() => {}, 1000)"],
      { cwd: workspaceRoot, timeoutMs: 10 },
    );
    expect(timedOut).toMatchObject({ exitCode: 124, timedOut: true });
  });

  it("measures configured artifacts and tolerances", async () => {
    const result = await runComparisonCase(
      {
        ...baseCase,
        commands: {
          build: [
            "node",
            "{workspaceRoot}/node_modules/typescript/bin/tsc",
            "-p",
            ".",
          ],
          test: ["node", "--test", "test/order.test.mjs"],
        },
        artifacts: { paths: ["dist/**/*.js"] },
        tolerances: { artifactSizeRegressionPercent: 1000 },
      },
      options,
    );
    expect(result.behaviorValid).toBe(true);
    expect(result.before.build?.timing.repetitions).toBe(1);
    expect(result.before.test?.passingTests).toBe(1);
    expect(result.after.artifactSizeBytes).toBeGreaterThan(0);
    expect(result.tolerances[0]?.withinTolerance).toBe(true);
  });
});
