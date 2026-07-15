import { mkdtemp, rm } from "node:fs/promises";
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
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const invoke = (arguments_: readonly string[], timeoutMs = 30_000) =>
  runCommand(["node", cli, ...arguments_], { cwd: workspaceRoot, timeoutMs });

describe("braid-bench CLI", () => {
  it("supports list, run, JSON, case filtering, compare, report, and compare-runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-bench-cli-"));
    temporaryDirectories.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const comparison = path.join(root, "comparison");

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
    expect(runsCompared.stdout).toContain("Deltas are run B minus run A");
  }, 30_000);
});
