import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  architectureSnapshotSchema,
  migrationProposalSchema,
  type MigrationProposal,
} from "@braid/core";
import { z } from "zod";
import { analyzeFixture } from "../evaluators/static-analysis.js";
import { evaluateProposalCase } from "../evaluators/proposal-evaluator.js";
import {
  copyFixture,
  initializeFixtureGit,
  removeFixture,
} from "../fixtures/fixture-copier.js";
import {
  benchmarkAssetPath,
  loadExpectation,
} from "../fixtures/fixture-loader.js";
import { changedFiles, hashSourceTree } from "../fixtures/source-hasher.js";
import type {
  ProposalBenchmarkCase,
  ProposalCaseResult,
} from "../models/benchmark.js";
import { runCommand } from "./command-runner.js";

const proposalOutputSchema = z.object({
  snapshotId: z.string().min(1),
  proposals: z.array(migrationProposalSchema),
});

export interface ProposalRunnerOptions {
  benchmarksRoot: string;
  braidCommand: readonly string[];
  repetitions: number;
  timeoutMs: number;
  keepWorkdirs: boolean;
  verbose?: boolean;
}

const invokeBraid = (
  prefix: readonly string[],
  arguments_: readonly string[],
): string[] => [...prefix, ...arguments_];

const proposalFilesAreIdempotent = async (
  workdir: string,
  proposals: readonly MigrationProposal[],
): Promise<boolean> => {
  try {
    const files = (
      await readdir(path.join(workdir, ".braid", "state", "proposals"))
    ).filter((file) => file.endsWith(".json"));
    return (
      files.length === new Set(proposals.map(({ id }) => id)).size &&
      files.every((file) => proposals.some(({ id }) => `${id}.json` === file))
    );
  } catch {
    return proposals.length === 0;
  }
};

export const runProposalCase = async (
  benchmarkCase: ProposalBenchmarkCase,
  options: ProposalRunnerOptions,
): Promise<ProposalCaseResult> => {
  if (options.repetitions < 2)
    throw new Error(
      "Proposal benchmark suites require at least two repetitions",
    );
  const template = benchmarkAssetPath(
    options.benchmarksRoot,
    benchmarkCase.fixture,
  );
  const templateBefore = await hashSourceTree(template);
  const workdir = await copyFixture(template);
  const redactions = {
    [workdir]: "<fixture>",
    [path.dirname(options.benchmarksRoot)]: "<workspace>",
  };

  try {
    await initializeFixtureGit(workdir, options.timeoutMs);
    const sourceBefore = await hashSourceTree(workdir);
    const configPath = path.join(workdir, ".braid", "architecture.yaml");
    const configuredArchitecture = await readFile(configPath, "utf8");
    const initialized = await runCommand(
      invokeBraid(options.braidCommand, benchmarkCase.braidCommands.init),
      { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
    );
    if (initialized.exitCode !== 0)
      throw new Error(
        `Braid init failed for ${benchmarkCase.id}: ${initialized.stderr}`,
      );
    await writeFile(configPath, configuredArchitecture, "utf8");

    const proposalRuns: MigrationProposal[][] = [];
    const durations: number[] = [];
    for (
      let repetition = 0;
      repetition < options.repetitions;
      repetition += 1
    ) {
      const analyzed = await runCommand(
        invokeBraid(options.braidCommand, benchmarkCase.braidCommands.analyze),
        { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
      );
      if (analyzed.exitCode !== 0)
        throw new Error(
          `Braid analyze failed for ${benchmarkCase.id}: ${analyzed.stderr}`,
        );
      architectureSnapshotSchema.parse(JSON.parse(analyzed.stdout));

      const proposed = await runCommand(
        invokeBraid(options.braidCommand, benchmarkCase.braidCommands.propose),
        { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
      );
      durations.push(proposed.durationMs);
      if (proposed.exitCode !== benchmarkCase.expectedExitCode)
        throw new Error(
          `Braid propose returned ${proposed.exitCode} for ${benchmarkCase.id}; expected ${benchmarkCase.expectedExitCode}: ${proposed.stderr}`,
        );
      proposalRuns.push(
        proposed.exitCode === 0
          ? proposalOutputSchema.parse(JSON.parse(proposed.stdout)).proposals
          : [],
      );
      if (options.verbose)
        process.stderr.write(
          `${benchmarkCase.id}: repetition ${repetition + 1}/${options.repetitions}\n`,
        );
    }

    const sourceAfter = await hashSourceTree(workdir);
    const templateAfter = await hashSourceTree(template);
    if (templateBefore.digest !== templateAfter.digest)
      throw new Error(
        `Tracked fixture template mutated: ${benchmarkCase.fixture}`,
      );
    const expectation = await loadExpectation(
      options.benchmarksRoot,
      benchmarkCase.expectationFile,
    );
    const proposals = proposalRuns[0] ?? [];
    return evaluateProposalCase({
      caseId: benchmarkCase.id,
      expectation,
      proposalRuns,
      durations,
      facts: await analyzeFixture(workdir),
      persistenceIdempotent: await proposalFilesAreIdempotent(
        workdir,
        proposals,
      ),
      sourceMutations: changedFiles(sourceBefore, sourceAfter),
    });
  } finally {
    if (!options.keepWorkdirs) await removeFixture(workdir);
    else process.stderr.write(`Kept benchmark workdir: ${workdir}\n`);
  }
};
