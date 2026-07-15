import { glob, stat } from "node:fs/promises";
import path from "node:path";
import {
  analyzeFixture,
  normalizedSourceTree,
} from "../evaluators/static-analysis.js";
import {
  copyFixture,
  initializeFixtureGit,
  removeFixture,
} from "../fixtures/fixture-copier.js";
import { benchmarkAssetPath } from "../fixtures/fixture-loader.js";
import { changedFiles, hashSourceTree } from "../fixtures/source-hasher.js";
import type {
  ArchitectureMeasurement,
  CommandMeasurement,
  StaticComparisonCase,
  StaticComparisonResult,
} from "../models/benchmark.js";
import {
  commandMeasurement,
  expandCommand,
  runCommand,
  type CommandResult,
} from "./command-runner.js";

export interface ComparisonRunnerOptions {
  benchmarksRoot: string;
  workspaceRoot: string;
  repetitions: number;
  timeoutMs: number;
  keepWorkdirs: boolean;
  verbose?: boolean;
}

interface VariantResult {
  architecture: ArchitectureMeasurement;
  build: CommandMeasurement | null;
  test: CommandMeasurement | null;
  runtimeBenchmark: CommandMeasurement | null;
  artifactSizeBytes: number | null;
  sourceMutations: string[];
}

const runRepeated = async (
  command: readonly string[] | undefined,
  workdir: string,
  options: ComparisonRunnerOptions,
): Promise<CommandMeasurement | null> => {
  if (!command) return null;
  const results: CommandResult[] = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    results.push(
      await runCommand(expandCommand(command, options.workspaceRoot), {
        cwd: workdir,
        timeoutMs: options.timeoutMs,
        redactions: {
          [workdir]: "<fixture>",
          [options.workspaceRoot]: "<workspace>",
        },
      }),
    );
  }
  return commandMeasurement(results);
};

const artifactSize = async (
  root: string,
  patterns: readonly string[] | undefined,
): Promise<number | null> => {
  if (!patterns) return null;
  let bytes = 0;
  const visited = new Set<string>();
  for await (const file of glob(patterns, { cwd: root })) {
    const normalized = file.replaceAll(path.sep, "/");
    if (
      visited.has(normalized) ||
      /(?:^|\/)node_modules(?:\/|$)/u.test(normalized)
    )
      continue;
    const details = await stat(path.join(root, file));
    if (!details.isFile()) continue;
    visited.add(normalized);
    bytes += details.size;
  }
  return bytes;
};

const runVariant = async (
  template: string,
  benchmarkCase: StaticComparisonCase,
  options: ComparisonRunnerOptions,
): Promise<{ result: VariantResult; workdir: string }> => {
  const templateBefore = await hashSourceTree(template);
  const workdir = await copyFixture(template);
  try {
    await initializeFixtureGit(workdir, options.timeoutMs);
    const sourceBefore = await hashSourceTree(workdir);
    const facts = await analyzeFixture(workdir);
    const build = await runRepeated(
      benchmarkCase.commands.build,
      workdir,
      options,
    );
    const test = await runRepeated(
      benchmarkCase.commands.test,
      workdir,
      options,
    );
    const runtimeBenchmark = await runRepeated(
      benchmarkCase.commands.runtimeBenchmark,
      workdir,
      options,
    );
    const result = {
      architecture: facts.architecture,
      build,
      test,
      runtimeBenchmark,
      artifactSizeBytes: await artifactSize(
        workdir,
        benchmarkCase.artifacts?.paths,
      ),
      sourceMutations: changedFiles(
        sourceBefore,
        await hashSourceTree(workdir),
      ),
    };
    if (templateBefore.digest !== (await hashSourceTree(template)).digest)
      throw new Error(`Tracked fixture template mutated: ${template}`);
    return { result, workdir };
  } catch (error) {
    if (!options.keepWorkdirs) await removeFixture(workdir);
    else process.stderr.write(`Kept failed benchmark workdir: ${workdir}\n`);
    throw error;
  }
};

const commandPassed = (measurement: CommandMeasurement | null): boolean =>
  measurement === null ||
  (!measurement.timedOut && measurement.exitCodes.every((code) => code === 0));

const regressionPercent = (
  before: number | null,
  after: number | null,
): number | null => {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
};

export const runComparisonCase = async (
  benchmarkCase: StaticComparisonCase,
  options: ComparisonRunnerOptions,
): Promise<StaticComparisonResult> => {
  const beforeTemplate = benchmarkAssetPath(
    options.benchmarksRoot,
    benchmarkCase.beforeFixture,
  );
  const afterTemplate = benchmarkAssetPath(
    options.benchmarksRoot,
    benchmarkCase.afterFixture,
  );
  const beforeTree = await normalizedSourceTree(beforeTemplate);
  const afterTree = await normalizedSourceTree(afterTemplate);
  const beforeRun = await runVariant(beforeTemplate, benchmarkCase, options);
  let afterRun: Awaited<ReturnType<typeof runVariant>> | undefined;
  try {
    afterRun = await runVariant(afterTemplate, benchmarkCase, options);
    const before = beforeRun.result;
    const after = afterRun.result;
    const keys = Object.keys(before.architecture) as Array<
      keyof ArchitectureMeasurement
    >;
    const architectureDelta = Object.fromEntries(
      keys.map((key) => [
        key,
        after.architecture[key] - before.architecture[key],
      ]),
    ) as Record<keyof ArchitectureMeasurement, number>;
    const tolerances: StaticComparisonResult["tolerances"] = [];
    const addTolerance = (
      metric: "buildDuration" | "testDuration" | "artifactSize",
      beforeValue: number | null,
      afterValue: number | null,
      tolerancePercent: number | undefined,
    ): void => {
      if (tolerancePercent === undefined) return;
      const regression = regressionPercent(beforeValue, afterValue);
      tolerances.push({
        metric,
        regressionPercent: regression,
        tolerancePercent,
        withinTolerance: regression === null || regression <= tolerancePercent,
      });
    };
    addTolerance(
      "buildDuration",
      before.build?.timing.medianMs ?? null,
      after.build?.timing.medianMs ?? null,
      benchmarkCase.tolerances?.buildDurationRegressionPercent,
    );
    addTolerance(
      "testDuration",
      before.test?.timing.medianMs ?? null,
      after.test?.timing.medianMs ?? null,
      benchmarkCase.tolerances?.testDurationRegressionPercent,
    );
    addTolerance(
      "artifactSize",
      before.artifactSizeBytes,
      after.artifactSizeBytes,
      benchmarkCase.tolerances?.artifactSizeRegressionPercent,
    );
    const beforeFiles = new Set(beforeTree.keys());
    const afterFiles = new Set(afterTree.keys());
    return {
      type: "static-comparison",
      caseId: benchmarkCase.id,
      before: {
        architecture: before.architecture,
        build: before.build,
        test: before.test,
        runtimeBenchmark: before.runtimeBenchmark,
        artifactSizeBytes: before.artifactSizeBytes,
      },
      after: {
        architecture: after.architecture,
        build: after.build,
        test: after.test,
        runtimeBenchmark: after.runtimeBenchmark,
        artifactSizeBytes: after.artifactSizeBytes,
      },
      architectureDelta,
      changeMagnitude: {
        filesAdded: [...afterFiles].filter((file) => !beforeFiles.has(file))
          .length,
        filesRemoved: [...beforeFiles].filter((file) => !afterFiles.has(file))
          .length,
        filesModified: [...beforeFiles].filter(
          (file) =>
            afterFiles.has(file) &&
            beforeTree.get(file)?.hash !== afterTree.get(file)?.hash,
        ).length,
        sourceLineDelta:
          after.architecture.sourceLinesOfCode -
          before.architecture.sourceLinesOfCode,
      },
      behaviorValid:
        commandPassed(before.build) &&
        commandPassed(before.test) &&
        commandPassed(after.build) &&
        commandPassed(after.test),
      tolerances,
      sourceMutations: [
        ...before.sourceMutations.map((file) => `before:${file}`),
        ...after.sourceMutations.map((file) => `after:${file}`),
      ],
    };
  } finally {
    if (!options.keepWorkdirs) {
      await removeFixture(beforeRun.workdir);
      if (afterRun) await removeFixture(afterRun.workdir);
    } else
      process.stderr.write(
        `Kept benchmark workdirs: ${beforeRun.workdir}${afterRun ? `, ${afterRun.workdir}` : ""}\n`,
      );
  }
};
