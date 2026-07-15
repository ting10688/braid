import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  architectureSnapshotSchema,
  migrationProposalSchema,
  type MigrationProposal,
} from "@braid/core";
import { z } from "zod";
import { analyzeFixture } from "../evaluators/static-analysis.js";
import {
  detectProposalFlakiness,
  type CorrectnessObservation,
} from "../evaluators/flakiness-evaluator.js";
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
import {
  changedFiles,
  hashSelectedTree,
  hashSourceTree,
  type TreeHash,
} from "../fixtures/source-hasher.js";
import type {
  BenchmarkProtocol,
  ProposalBenchmarkCase,
  ProposalCaseResult,
  RepositoryManifest,
  RepositoryProposalBenchmarkCase,
} from "../models/benchmark.js";
import {
  loadRepositoryManifest,
  materializeRepository,
  removeMaterializedRepository,
  repositoryMetadataPath,
  verifyRepositoryCache,
} from "../repositories/repository-materializer.js";
import { runCommand } from "./command-runner.js";

const proposalOutputSchema = z.object({
  snapshotId: z.string().min(1),
  proposals: z.array(migrationProposalSchema),
});

export interface ProposalRunnerOptions {
  workspaceRoot: string;
  benchmarksRoot: string;
  braidCommand: readonly string[];
  correctnessRepetitions: number;
  timingRepetitions: number;
  warmupRuns: number;
  normalizationRules: BenchmarkProtocol["normalizationRules"];
  expectationVersion: string;
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
  benchmarkCase: ProposalBenchmarkCase | RepositoryProposalBenchmarkCase,
  options: ProposalRunnerOptions,
): Promise<ProposalCaseResult> => {
  if (options.correctnessRepetitions < 2)
    throw new Error(
      "Proposal benchmark suites require at least two repetitions",
    );
  const setupStarted = performance.now();
  let repository: RepositoryManifest | undefined;
  let template: string | undefined;
  let templateBefore: TreeHash | undefined;
  let workdir: string;
  let hashWorkdir: (root: string) => Promise<TreeHash>;
  let configuredArchitecture: string;
  if (benchmarkCase.type === "repository-proposal") {
    repository = await loadRepositoryManifest(
      options.benchmarksRoot,
      benchmarkCase.repositoryId,
    );
    const materialized = await materializeRepository(
      repository,
      path.join(options.workspaceRoot, ".braid-bench-cache", "repositories"),
    );
    workdir = materialized.workdir;
    hashWorkdir = (root) =>
      hashSelectedTree(
        root,
        repository!.source.include,
        repository!.source.exclude,
      );
    configuredArchitecture = await readFile(
      path.join(
        repositoryMetadataPath(options.benchmarksRoot, repository.id),
        repository.braidConfiguration.file,
      ),
      "utf8",
    );
  } else {
    template = benchmarkAssetPath(
      options.benchmarksRoot,
      benchmarkCase.fixture,
    );
    templateBefore = await hashSourceTree(template);
    workdir = await copyFixture(template);
    hashWorkdir = hashSourceTree;
    configuredArchitecture = await readFile(
      path.join(workdir, ".braid", "architecture.yaml"),
      "utf8",
    );
  }
  const redactions = {
    [workdir]: "<fixture>",
    [path.dirname(options.benchmarksRoot)]: "<workspace>",
  };

  try {
    if (benchmarkCase.type === "proposal")
      await initializeFixtureGit(workdir, options.timeoutMs);
    const sourceBefore = await hashWorkdir(workdir);
    const configPath = path.join(workdir, ".braid", "architecture.yaml");
    const initialized = await runCommand(
      invokeBraid(options.braidCommand, benchmarkCase.braidCommands.init),
      { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
    );
    if (initialized.exitCode !== 0)
      throw new Error(
        `Braid init failed for ${benchmarkCase.id}: ${initialized.stderr}`,
      );
    await writeFile(configPath, configuredArchitecture, "utf8");
    const setupDurationMs = performance.now() - setupStarted;

    const proposalRuns: MigrationProposal[][] = [];
    const observations: CorrectnessObservation[] = [];
    const durations: number[] = [];
    for (
      let repetition = 0;
      repetition < options.correctnessRepetitions;
      repetition += 1
    ) {
      const repetitionBefore = await hashWorkdir(workdir);
      const analyzed = await runCommand(
        invokeBraid(options.braidCommand, benchmarkCase.braidCommands.analyze),
        { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
      );
      if (analyzed.exitCode === 0)
        architectureSnapshotSchema.parse(JSON.parse(analyzed.stdout));
      const proposed =
        analyzed.exitCode === 0
          ? await runCommand(
              invokeBraid(
                options.braidCommand,
                benchmarkCase.braidCommands.propose,
              ),
              { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
            )
          : analyzed;
      const proposals =
        analyzed.exitCode === 0 && proposed.exitCode === 0
          ? proposalOutputSchema.parse(JSON.parse(proposed.stdout)).proposals
          : [];
      proposalRuns.push(proposals);
      observations.push({
        proposals,
        exitCode: proposed.exitCode,
        sourceMutations: changedFiles(
          repetitionBefore,
          await hashWorkdir(workdir),
        ),
      });
      if (options.verbose)
        process.stderr.write(
          `${benchmarkCase.id}: correctness ${repetition + 1}/${options.correctnessRepetitions}\n`,
        );
    }

    for (
      let repetition = 0;
      repetition < options.warmupRuns + options.timingRepetitions;
      repetition += 1
    ) {
      const proposed = await runCommand(
        invokeBraid(options.braidCommand, benchmarkCase.braidCommands.propose),
        { cwd: workdir, timeoutMs: options.timeoutMs, redactions },
      );
      if (proposed.exitCode === 0)
        proposalOutputSchema.parse(JSON.parse(proposed.stdout));
      if (repetition >= options.warmupRuns) durations.push(proposed.durationMs);
      if (options.verbose)
        process.stderr.write(
          `${benchmarkCase.id}: ${repetition < options.warmupRuns ? "warmup" : "timing"} ${repetition + 1}/${options.warmupRuns + options.timingRepetitions}\n`,
        );
    }

    const sourceAfter = await hashWorkdir(workdir);
    if (template && templateBefore) {
      const templateAfter = await hashSourceTree(template);
      if (templateBefore.digest !== templateAfter.digest)
        throw new Error(
          `Tracked fixture template mutated: ${benchmarkCase.id}`,
        );
    }
    if (repository)
      await verifyRepositoryCache(
        repository,
        path.join(options.workspaceRoot, ".braid-bench-cache", "repositories"),
      );
    const expectation = await loadExpectation(
      options.benchmarksRoot,
      benchmarkCase.expectationFile,
    );
    if (expectation.version !== options.expectationVersion)
      throw new Error(
        `Expectation ${benchmarkCase.expectationFile} is version ${expectation.version}; suite requires ${options.expectationVersion}`,
      );
    const proposals = proposalRuns[0] ?? [];
    const flakiness = detectProposalFlakiness(
      observations,
      options.normalizationRules,
      { temporaryDirectories: [workdir] },
    );
    return {
      ...evaluateProposalCase({
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
        flakiness,
        exitCodes: observations.map(({ exitCode }) => exitCode),
        expectedExitCode: benchmarkCase.expectedExitCode,
      }),
      setupDurationMs,
    };
  } finally {
    if (!options.keepWorkdirs)
      await (repository
        ? removeMaterializedRepository(workdir)
        : removeFixture(workdir));
    else process.stderr.write(`Kept benchmark workdir: ${workdir}\n`);
  }
};
