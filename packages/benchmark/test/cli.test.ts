import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/runner/command-runner.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cli = path.join(
  workspaceRoot,
  "packages",
  "benchmark",
  "dist",
  "cli",
  "index.js",
);
const braidCli = path.join(workspaceRoot, "apps", "cli", "dist", "index.js");
const baselinesRoot = path.join(workspaceRoot, "benchmarks", "baselines");
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await Promise.all(
    temporaryFiles.splice(0).map((file) => rm(file, { force: true })),
  );
});

const invoke = (arguments_: readonly string[], timeoutMs = 180_000) =>
  runCommand(["node", cli, ...arguments_], { cwd: workspaceRoot, timeoutMs });

describe("braid-bench CLI", () => {
  it("supports runs, baselines, comparisons, overrides, and iteration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-bench-cli-"));
    temporaryDirectories.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const comparison = path.join(root, "comparison");
    const incompatible = path.join(root, "incompatible");
    const iteration = path.join(root, "iteration");
    const baselineName = `cli-test-${process.pid}`;
    temporaryFiles.push(path.join(baselinesRoot, `${baselineName}.json`));

    const listed = await invoke(["list"]);
    expect(listed.stdout).toContain("phase-2-core");

    const consoleRun = await invoke([
      "run",
      "--suite",
      "phase-2-core",
      "--case",
      "clean-modular-app",
      "--output",
      first,
    ]);
    expect(consoleRun.stdout).toContain("Braid Bench: phase-2-core");

    const jsonRun = await invoke([
      "run",
      "--suite",
      "phase-2-core",
      "--case",
      "clean-modular-app",
      "--json",
      "--output",
      second,
    ]);
    expect(JSON.parse(jsonRun.stdout).cases).toHaveLength(1);
    expect(jsonRun.stderr).toBe("");

    const compared = await invoke([
      "compare",
      "--suite",
      "static-comparison",
      "--output",
      comparison,
    ]);
    expect(compared.stdout).toContain("behavior valid");

    const reported = await invoke(["report", first]);
    expect(reported.stdout).toContain("Expected issue coverage");

    const runsCompared = await invoke(["compare-runs", first, second]);
    expect(runsCompared.stdout).toContain("Result: PASS");
    expect(runsCompared.stderr).toBe("");

    const unconfirmed = await invoke([
      "baseline",
      "create",
      "--run",
      first,
      "--name",
      baselineName,
    ]);
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr).toContain("requires --force");

    const created = await invoke([
      "baseline",
      "create",
      "--run",
      first,
      "--name",
      baselineName,
      "--force",
    ]);
    expect(created.stdout).toContain(`Created baseline ${baselineName}`);
    expect((await invoke(["baseline", "list"])).stdout).toContain(baselineName);
    expect(
      JSON.parse((await invoke(["baseline", "show", baselineName])).stdout),
    ).toMatchObject({ name: baselineName });
    expect(
      (await invoke(["compare-baseline", baselineName, second])).stdout,
    ).toContain("Result: PASS");

    await cp(first, incompatible, { recursive: true });
    const incompatibleRun = JSON.parse(
      await readFile(path.join(incompatible, "run.json"), "utf8"),
    ) as { manifest: { suiteVersion: string } };
    incompatibleRun.manifest.suiteVersion = "2.0.0";
    await writeFile(
      path.join(incompatible, "run.json"),
      `${JSON.stringify(incompatibleRun, null, 2)}\n`,
    );
    await writeFile(
      path.join(incompatible, "manifest.json"),
      `${JSON.stringify(incompatibleRun.manifest, null, 2)}\n`,
    );
    const rejected = await invoke(["compare-runs", first, incompatible]);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stdout).toContain("Incompatibilities:");
    const overridden = await invoke([
      "compare-runs",
      first,
      incompatible,
      "--allow-incompatible",
    ]);
    expect(overridden.exitCode).toBe(3);
    expect(overridden.stdout).toContain("Expected issue coverage");

    const iterated = await invoke([
      "iteration",
      "--suite",
      "phase-2-core",
      "--case",
      "clean-modular-app",
      "--baseline-braid",
      braidCli,
      "--candidate-braid",
      braidCli,
      "--output",
      iteration,
    ]);
    expect(iterated.exitCode).toBe(0);
    expect(iterated.stdout).toContain("Result: PASS");
    expect(iterated.stderr).toBe("");
    expect(
      JSON.parse(
        await readFile(path.join(iteration, "comparison.json"), "utf8"),
      ),
    ).toMatchObject({ overallResult: "pass" });
  }, 180_000);
});
