import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGoldenBaseline,
  listGoldenBaselines,
  loadGoldenBaseline,
} from "../src/baselines/golden-baseline.js";
import { compareBenchmarkSummaries } from "../src/evaluators/iteration-comparator.js";
import { regressionPolicySchema } from "../src/models/benchmark.js";
import { loadRun, writeReports } from "../src/reports/reporters.js";
import { benchmarkRunFixture } from "./benchmark-run-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const root = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "braid-baseline-"));
  temporaryDirectories.push(directory);
  return directory;
};

const policy = regressionPolicySchema.parse({
  schemaVersion: 1,
  policyVersion: "1.0.0",
  blocking: { flakyCases: { maximum: 0 } },
  warnings: {},
});

describe("golden baselines", () => {
  it("requires force, rejects duplicate creation without it, and supports list/show", async () => {
    const directory = await root();
    const run = benchmarkRunFixture();
    await expect(
      createGoldenBaseline(directory, run, "golden", false),
    ).rejects.toThrow(/requires --force/u);
    await createGoldenBaseline(directory, run, "golden", true);
    await expect(
      createGoldenBaseline(directory, run, "golden", false),
    ).rejects.toThrow(/requires --force/u);
    expect(await listGoldenBaselines(directory)).toEqual(["golden"]);
    expect(await loadGoldenBaseline(directory, "golden")).toMatchObject({
      name: "golden",
      createdFromRunId: run.runId,
    });
  });

  it("stores no private absolute paths and compares compatibly", async () => {
    const directory = await root();
    const run = benchmarkRunFixture();
    const golden = await createGoldenBaseline(directory, run, "golden", true);
    const contents = await readFile(
      path.join(directory, "golden.json"),
      "utf8",
    );
    expect(contents).not.toContain("/Users/alice");
    expect(contents).not.toContain("projects/braid");
    const comparison = compareBenchmarkSummaries(
      {
        runId: golden.createdFromRunId,
        manifest: golden.manifest,
        summary: golden.summary,
      },
      {
        runId: run.runId,
        manifest: run.manifest,
        summary: golden.summary,
      },
      policy,
    );
    expect(comparison.compatible).toBe(true);
  });

  it("detects an incompatible baseline comparison", async () => {
    const directory = await root();
    const run = benchmarkRunFixture();
    const golden = await createGoldenBaseline(directory, run, "golden", true);
    const comparison = compareBenchmarkSummaries(
      {
        runId: golden.createdFromRunId,
        manifest: golden.manifest,
        summary: golden.summary,
      },
      {
        runId: "candidate",
        manifest: { ...run.manifest, suiteVersion: "2.0.0" },
        summary: golden.summary,
      },
      policy,
    );
    expect(comparison.overallResult).toBe("incompatible");
  });
});

describe("immutable run manifests", () => {
  it("writes and verifies manifest sidecars without replacing them", async () => {
    const directory = await root();
    const run = benchmarkRunFixture();
    await writeReports(run, directory);
    expect(await loadRun(directory)).toEqual(run);
    await expect(
      writeReports(
        {
          ...run,
          manifest: { ...run.manifest, suiteVersion: "2.0.0" },
        },
        directory,
      ),
    ).rejects.toThrow(/immutable manifest/u);
  });
});
