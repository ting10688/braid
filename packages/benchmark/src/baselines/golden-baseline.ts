import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { benchmarkSummary } from "../evaluators/benchmark-summary.js";
import {
  goldenBaselineSchema,
  type BenchmarkRun,
  type GoldenBaseline,
} from "../models/benchmark.js";

const baselineName = (name: string): string => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
    throw new Error(`Invalid baseline name: ${name}`);
  return name;
};

const baselineFile = (root: string, name: string): string =>
  path.join(root, `${baselineName(name)}.json`);

const redactAbsolutePaths = (command: string): string =>
  command
    .split(" ")
    .map((part) => {
      if (path.isAbsolute(part)) return "<absolute-path>";
      const separator = part.indexOf("=");
      return separator >= 0 && path.isAbsolute(part.slice(separator + 1))
        ? `${part.slice(0, separator + 1)}<absolute-path>`
        : part;
    })
    .join(" ");

export const baselineFromRun = (
  run: BenchmarkRun,
  name: string,
): GoldenBaseline =>
  goldenBaselineSchema.parse({
    schemaVersion: 1,
    name: baselineName(name),
    createdFromRunId: run.runId,
    manifest: {
      ...run.manifest,
      execution: {
        ...run.manifest.execution,
        command: redactAbsolutePaths(run.manifest.execution.command),
      },
    },
    summary: benchmarkSummary(run),
    braid: run.braid,
    benchmark: run.benchmark,
  });

export const createGoldenBaseline = async (
  root: string,
  run: BenchmarkRun,
  name: string,
  force = false,
): Promise<GoldenBaseline> => {
  if (!force)
    throw new Error(
      "Creating or replacing a tracked baseline requires --force",
    );
  const baseline = baselineFromRun(run, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    baselineFile(root, name),
    `${JSON.stringify(baseline, null, 2)}\n`,
    { encoding: "utf8", flag: "w" },
  );
  return baseline;
};

export const loadGoldenBaseline = async (
  root: string,
  name: string,
): Promise<GoldenBaseline> =>
  goldenBaselineSchema.parse(
    JSON.parse(await readFile(baselineFile(root, name), "utf8")),
  );

export const listGoldenBaselines = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(root))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return [];
    throw error;
  }
};
