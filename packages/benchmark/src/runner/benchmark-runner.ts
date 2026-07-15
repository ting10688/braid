import path from "node:path";
import type { BenchmarkSuite } from "../models/benchmark.js";
import { benchmarkRunSchema, type BenchmarkRun } from "../models/benchmark.js";
import { createFixtureManifest } from "../fixtures/fixture-manifest.js";
import { loadProtocol } from "../fixtures/fixture-loader.js";
import { runComparisonCase } from "./comparison-runner.js";
import {
  environmentFingerprint,
  gitCommit,
  gitCommitForCommand,
  normalizedCommand,
} from "./environment-fingerprint.js";
import { runProposalCase } from "./proposal-runner.js";
import { runCommand } from "./command-runner.js";

export interface BenchmarkRunnerOptions {
  workspaceRoot: string;
  benchmarksRoot: string;
  braidCommand: readonly string[];
  caseId?: string;
  smoke?: boolean;
  keepWorkdirs: boolean;
  verbose?: boolean;
  kind: "proposal" | "static-comparison";
}

const braidVersion = async (
  command: readonly string[],
  workspaceRoot: string,
): Promise<string> => {
  const result = await runCommand([...command, "--version"], {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
    redactions: { [workspaceRoot]: "<workspace>" },
  });
  return result.exitCode === 0 ? result.stdout.trim() : "unknown";
};

export const runBenchmarkSuite = async (
  suite: BenchmarkSuite,
  options: BenchmarkRunnerOptions,
): Promise<BenchmarkRun> => {
  const startedAt = new Date();
  const selected = suite.cases.filter(
    (benchmarkCase) =>
      benchmarkCase.type === options.kind &&
      (!options.caseId || benchmarkCase.id === options.caseId) &&
      (!options.smoke || ("smoke" in benchmarkCase && benchmarkCase.smoke)),
  );
  if (selected.length === 0)
    throw new Error(
      `No ${options.kind} benchmark cases matched the requested filters`,
    );
  const protocol = await loadProtocol(options.benchmarksRoot);
  const selectedSuite: BenchmarkSuite = { ...suite, cases: selected };
  const fixture = await createFixtureManifest(
    options.benchmarksRoot,
    selectedSuite,
    protocol,
  );
  const cases = [];
  for (const benchmarkCase of selected) {
    if (options.verbose) process.stderr.write(`Running ${benchmarkCase.id}\n`);
    if (benchmarkCase.type === "proposal")
      cases.push(
        await runProposalCase(benchmarkCase, {
          benchmarksRoot: options.benchmarksRoot,
          braidCommand: options.braidCommand,
          correctnessRepetitions: fixture.execution.correctnessRepetitions,
          timingRepetitions: fixture.execution.timingRepetitions,
          warmupRuns: fixture.execution.warmupRuns,
          normalizationRules: protocol.normalizationRules,
          expectationVersion: suite.expectationVersion,
          timeoutMs: fixture.execution.timeoutMs,
          keepWorkdirs: options.keepWorkdirs,
          ...(options.verbose === undefined
            ? {}
            : { verbose: options.verbose }),
        }),
      );
    else if (benchmarkCase.type === "static-comparison")
      cases.push(
        await runComparisonCase(benchmarkCase, {
          benchmarksRoot: options.benchmarksRoot,
          workspaceRoot: options.workspaceRoot,
          correctnessRepetitions: fixture.execution.correctnessRepetitions,
          timingRepetitions: fixture.execution.timingRepetitions,
          warmupRuns: fixture.execution.warmupRuns,
          timeoutMs: fixture.execution.timeoutMs,
          keepWorkdirs: options.keepWorkdirs,
          ...(options.verbose === undefined
            ? {}
            : { verbose: options.verbose }),
        }),
      );
    else
      throw new Error(`Execution is not implemented for ${benchmarkCase.type}`);
  }
  const benchmarkCommit = await gitCommit(options.workspaceRoot);
  const braidCommit = await gitCommitForCommand(options.braidCommand);
  const version = await braidVersion(
    options.braidCommand,
    options.workspaceRoot,
  );
  const environment = await environmentFingerprint(options.workspaceRoot);
  const command = normalizedCommand(
    options.braidCommand,
    options.workspaceRoot,
  );
  const completedAt = new Date();
  const runId = `${suite.id}-${startedAt.toISOString().replaceAll(/[-:.]/gu, "")}`;
  return benchmarkRunSchema.parse({
    schemaVersion: 1,
    runId,
    suiteId: suite.id,
    suiteVersion: suite.suiteVersion,
    expectationVersion: suite.expectationVersion,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    braid: {
      commit: braidCommit,
      version,
      command,
    },
    benchmark: { commit: benchmarkCommit, version: "0.2.0" },
    environment,
    manifest: {
      schemaVersion: 1,
      protocolVersion: protocol.protocolVersion,
      suiteId: suite.id,
      suiteVersion: suite.suiteVersion,
      expectationVersion: suite.expectationVersion,
      fixtureManifestVersion: fixture.manifest.manifestVersion,
      fixtureManifestHash: fixture.manifest.hash,
      configurationHash: fixture.configurationHash,
      braidVersion: version,
      braidCommit,
      benchmarkVersion: "0.2.0",
      benchmarkCommit,
      environment: {
        platform: process.platform,
        architecture: environment.architecture,
        nodeVersion: environment.nodeVersion,
        pnpmVersion: environment.pnpmVersion,
        gitVersion: environment.gitVersion,
      },
      execution: {
        ...fixture.execution,
        command,
      },
    },
    fixtureManifest: fixture.manifest,
    cases,
  });
};

export const defaultBraidCommand = (workspaceRoot: string): string[] => [
  "node",
  path.join(workspaceRoot, "apps", "cli", "dist", "index.js"),
];
