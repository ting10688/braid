import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { RepositoryManifest } from "../models/benchmark.js";
import { changedFiles, hashSelectedTree } from "../fixtures/source-hasher.js";
import { runCommand, type CommandResult } from "../runner/command-runner.js";
import {
  materializeRepository,
  removeMaterializedRepository,
  repositoryMetadataPath,
  verifyRepositoryCache,
} from "./repository-materializer.js";

interface QualificationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface RepositoryQualificationResult {
  id: string;
  recordedStatus: RepositoryManifest["qualification"]["status"];
  outcome: RepositoryManifest["qualification"]["status"];
  cacheVerified: boolean;
  install: QualificationCommandResult;
  build: QualificationCommandResult;
  test: QualificationCommandResult;
  braidAnalysis: QualificationCommandResult;
  braidProposal: QualificationCommandResult;
  proposalCount: number;
  sourceMutations: string[];
  totalDurationMs: number;
}

const summary = (
  command: readonly string[],
  result: CommandResult,
): QualificationCommandResult => ({
  command: command.join(" "),
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  timedOut: result.timedOut,
});

export const qualifyRepository = async (
  manifest: RepositoryManifest,
  options: {
    workspaceRoot: string;
    benchmarksRoot: string;
    braidCommand: readonly string[];
    timeoutMs?: number;
    keepWorkdir?: boolean;
  },
): Promise<RepositoryQualificationResult> => {
  const started = performance.now();
  const cacheRoot = path.join(
    options.workspaceRoot,
    ".braid-bench-cache",
    "repositories",
  );
  const materialized = await materializeRepository(manifest, cacheRoot);
  const workdir = materialized.workdir;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const redactions = {
    [workdir]: "<repository>",
    [options.workspaceRoot]: "<workspace>",
  };
  const run = (command: readonly string[]): Promise<CommandResult> =>
    runCommand(command, { cwd: workdir, timeoutMs, redactions });
  const source = (): ReturnType<typeof hashSelectedTree> =>
    hashSelectedTree(workdir, manifest.source.include, manifest.source.exclude);

  try {
    const before = await source();
    const installCommand = [
      manifest.commands.install.executable,
      ...manifest.commands.install.arguments,
    ];
    const buildCommand = [
      manifest.commands.build.executable,
      ...manifest.commands.build.arguments,
    ];
    const testCommand = [
      manifest.commands.test.executable,
      ...manifest.commands.test.arguments,
    ];
    const install = await run(installCommand);
    const build =
      install.exitCode === 0
        ? await run(buildCommand)
        : { ...install, durationMs: 0 };
    const test =
      install.exitCode === 0
        ? await run(testCommand)
        : { ...install, durationMs: 0 };

    const initCommand = [...options.braidCommand, "init", ".", "--force"];
    const init = await run(initCommand);
    if (init.exitCode === 0)
      await copyFile(
        path.join(
          repositoryMetadataPath(options.benchmarksRoot, manifest.id),
          manifest.braidConfiguration.file,
        ),
        path.join(workdir, ".braid", "architecture.yaml"),
      );
    const analysisCommand = [...options.braidCommand, "analyze", ".", "--json"];
    const analysis =
      init.exitCode === 0
        ? await run(analysisCommand)
        : { ...init, durationMs: 0 };
    const proposalCommand = [...options.braidCommand, "propose", ".", "--json"];
    const proposal =
      analysis.exitCode === 0
        ? await run(proposalCommand)
        : { ...analysis, durationMs: 0 };
    let proposalCount = 0;
    if (proposal.exitCode === 0) {
      const parsed = JSON.parse(proposal.stdout) as { proposals?: unknown[] };
      proposalCount = parsed.proposals?.length ?? 0;
    }
    const mutations = changedFiles(before, await source());
    await verifyRepositoryCache(manifest, cacheRoot);
    const corePassed = [install, build, test, analysis, proposal].every(
      ({ exitCode, timedOut }) => exitCode === 0 && !timedOut,
    );
    return {
      id: manifest.id,
      recordedStatus: manifest.qualification.status,
      outcome:
        corePassed && mutations.length === 0
          ? manifest.qualification.status
          : "rejected",
      cacheVerified: true,
      install: summary(installCommand, install),
      build: summary(buildCommand, build),
      test: summary(testCommand, test),
      braidAnalysis: summary(["braid", "analyze", ".", "--json"], analysis),
      braidProposal: summary(["braid", "propose", ".", "--json"], proposal),
      proposalCount,
      sourceMutations: mutations,
      totalDurationMs: performance.now() - started,
    };
  } finally {
    if (!options.keepWorkdir) await removeMaterializedRepository(workdir);
    else process.stderr.write(`Kept qualification workdir: ${workdir}\n`);
  }
};
