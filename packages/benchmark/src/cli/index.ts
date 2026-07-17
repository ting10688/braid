#!/usr/bin/env node
import { glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command, CommanderError } from "commander";
import {
  createGoldenBaseline,
  listGoldenBaselines,
  loadGoldenBaseline,
} from "../baselines/golden-baseline.js";
import { benchmarkSummary } from "../evaluators/benchmark-summary.js";
import {
  compareBenchmarkRuns,
  compareBenchmarkSummaries,
} from "../evaluators/iteration-comparator.js";
import { loadRegressionPolicy, loadSuite } from "../fixtures/fixture-loader.js";
import type {
  BenchmarkRun,
  BenchmarkSuite,
  IterationComparison,
} from "../models/benchmark.js";
import {
  comparisonConsoleReport,
  comparisonMarkdownReport,
  consoleReport,
  loadRun,
  markdownReport,
  writeComparisonReports,
  writeReports,
} from "../reports/reporters.js";
import {
  defaultBraidCommand,
  runBenchmarkSuite,
} from "../runner/benchmark-runner.js";
import {
  listRepositoryManifests,
  loadRepositoryManifest,
  refreshRepositoryCache,
  verifyRepositoryCache,
} from "../repositories/repository-materializer.js";
import { qualifyRepository } from "../repositories/repository-qualification.js";
import {
  migrationBenchmarkConsoleReport,
  runMigrationExecutionBenchmark,
} from "../migration-execution-suite.js";
import {
  readinessBenchmarkConsoleReport,
  runReadinessBenchmark,
} from "../readiness-suite.js";
import {
  proposalRepairSuggestionBenchmarkConsoleReport,
  runProposalRepairSuggestionBenchmark,
} from "../proposal-repair-suggestion-suite.js";
import {
  formatGrowthModeBenchmark,
  runGrowthModeBenchmark,
} from "../growth-mode-suite.js";
import {
  collectDurableMigrationRecoveryBenchmarkEvidence,
  durableMigrationRecoveryBenchmarkConsoleReport,
  runDurableMigrationRecoveryBenchmark,
} from "../durable-migration-recovery-suite.js";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const benchmarksRoot = path.join(workspaceRoot, "benchmarks");
const baselinesRoot = path.join(benchmarksRoot, "baselines");
const repositoryCacheRoot = path.join(
  workspaceRoot,
  ".braid-bench-cache",
  "repositories",
);

interface CommonOptions {
  suite: string;
  case?: string;
  output?: string;
  braidCommand?: string;
  keepWorkdirs?: boolean;
  verbose?: boolean;
  json?: boolean;
  smoke?: boolean;
}

interface ComparisonOptions {
  allowIncompatible?: boolean;
  output?: string;
  policy?: string;
  json?: boolean;
  markdown?: boolean;
}

const parseCommand = (input: string | undefined): string[] => {
  if (!input) return defaultBraidCommand(workspaceRoot);
  const parts = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
  if (parts.length === 0) throw new Error("--braid-command must not be empty");
  return parts;
};

const executableCommand = (input: string): string[] => {
  const executable = path.resolve(input);
  return executable.endsWith(".js") ? ["node", executable] : [executable];
};

const suiteKind = (suite: BenchmarkSuite): "proposal" | "static-comparison" => {
  const kinds = new Set(
    suite.cases
      .map(({ type }) => (type === "repository-proposal" ? "proposal" : type))
      .filter((type) => ["proposal", "static-comparison"].includes(type)),
  );
  if (kinds.size !== 1)
    throw new Error("Iteration suites must contain one executable case type");
  const kind = [...kinds][0];
  if (kind !== "proposal" && kind !== "static-comparison")
    throw new Error(`Execution is not implemented for ${String(kind)}`);
  return kind;
};

const execute = async (
  kind: "proposal" | "static-comparison",
  options: CommonOptions,
): Promise<BenchmarkRun> => {
  const suite = await loadSuite(benchmarksRoot, options.suite);
  const run = await runBenchmarkSuite(suite, {
    workspaceRoot,
    benchmarksRoot,
    braidCommand: parseCommand(options.braidCommand),
    ...(options.case ? { caseId: options.case } : {}),
    ...(options.smoke === undefined ? {} : { smoke: options.smoke }),
    keepWorkdirs: options.keepWorkdirs ?? false,
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    kind,
  });
  const outputDirectory = options.output
    ? path.resolve(options.output)
    : path.join(benchmarksRoot, "results", run.runId);
  await writeReports(run, outputDirectory);
  process.stdout.write(
    options.json ? `${JSON.stringify(run, null, 2)}\n` : consoleReport(run),
  );
  return run;
};

const comparisonExitCode = (comparison: IterationComparison): void => {
  if (comparison.overallResult === "fail") process.exitCode = 2;
  else if (comparison.overallResult === "incompatible") process.exitCode = 3;
};

const printComparison = (
  comparison: IterationComparison,
  options: ComparisonOptions,
): void => {
  process.stdout.write(
    options.json
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : options.markdown
        ? comparisonMarkdownReport(comparison)
        : comparisonConsoleReport(comparison),
  );
  comparisonExitCode(comparison);
};

const program = new Command()
  .name("braid-bench")
  .description("Independent reproducible benchmarks for Braid")
  .version("0.3.0");

program
  .command("list")
  .description("List benchmark suites")
  .action(async () => {
    const suites = [];
    for await (const file of glob("*.yaml", {
      cwd: path.join(benchmarksRoot, "suites"),
    }))
      suites.push(
        await loadSuite(benchmarksRoot, path.basename(file, ".yaml")),
      );
    process.stdout.write(
      `${suites
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
          (suite) =>
            `${suite.id}@${suite.suiteVersion}\t${suite.title}\t${suite.cases.length} cases`,
        )
        .join("\n")}\n`,
    );
  });

const repositories = program
  .command("repositories")
  .description("Manage pinned real-world repository inputs");

repositories.command("list").action(async () => {
  const manifests = await listRepositoryManifests(benchmarksRoot);
  process.stdout.write(
    `${manifests
      .map(
        (manifest) =>
          `${manifest.id}\t${manifest.qualification.status}\t${manifest.repository.commit}\t${manifest.repository.url}`,
      )
      .join("\n")}\n`,
  );
});

repositories
  .command("inspect")
  .argument("<id>")
  .action(async (id: string) => {
    const manifest = await loadRepositoryManifest(benchmarksRoot, id);
    const verification = await verifyRepositoryCache(
      manifest,
      repositoryCacheRoot,
    );
    process.stdout.write(
      `${JSON.stringify({ manifest, verification }, null, 2)}\n`,
    );
  });

program
  .command("migration")
  .description("Run the deterministic Phase 3 migration-execution suite")
  .option("--mode <mode>", "smoke, run, or regression", "run")
  .option("--json", "write one JSON report")
  .action(async (options: { mode: string; json?: boolean }) => {
    if (!["smoke", "run", "regression"].includes(options.mode))
      throw new Error(`Unknown migration benchmark mode: ${options.mode}`);
    const report = await runMigrationExecutionBenchmark({
      smoke: options.mode === "smoke",
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : migrationBenchmarkConsoleReport(report),
    );
    if (options.mode === "regression" && report.regressions.length > 0)
      process.exitCode = 2;
  });

program
  .command("readiness")
  .description("Run the deterministic Phase 3.1 execution-readiness suite")
  .option("--json", "write one JSON report")
  .action(async (options: { json?: boolean }) => {
    const report = await runReadinessBenchmark();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : readinessBenchmarkConsoleReport(report),
    );
    if (report.regressions.length > 0) process.exitCode = 2;
  });

program
  .command("repair-suggestions")
  .description("Run the deterministic Phase 3.2 proposal-repair suite")
  .option("--json", "write one JSON report")
  .action(async (options: { json?: boolean }) => {
    const report = await runProposalRepairSuggestionBenchmark();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : proposalRepairSuggestionBenchmarkConsoleReport(report),
    );
    if (report.regressions.length > 0) process.exitCode = 2;
  });

program
  .command("growth-mode")
  .description("Run the deterministic Growth Mode live-guard suite")
  .option("--json", "write one JSON report")
  .action(async (options: { json?: boolean }) => {
    const report = await runGrowthModeBenchmark();
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatGrowthModeBenchmark(report)}\n`,
    );
    if (report.regressions.length > 0) process.exitCode = 2;
  });

program
  .command("recovery")
  .description("Run the deterministic Phase 4 durable-recovery suite")
  .option("--json", "write one JSON report")
  .action(async (options: { json?: boolean }) => {
    const collected =
      await collectDurableMigrationRecoveryBenchmarkEvidence(workspaceRoot);
    const report = await runDurableMigrationRecoveryBenchmark(
      collected.evidence,
      collected.provenance,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : durableMigrationRecoveryBenchmarkConsoleReport(report),
    );
    if (report.regressions.length > 0) process.exitCode = 2;
  });

repositories
  .command("qualify")
  .argument("[id]")
  .option("--keep-workdirs", "keep temporary repository copies")
  .action(
    async (id: string | undefined, options: { keepWorkdirs?: boolean }) => {
      const manifests = id
        ? [await loadRepositoryManifest(benchmarksRoot, id)]
        : await listRepositoryManifests(benchmarksRoot);
      const results = [];
      for (const manifest of manifests)
        results.push(
          await qualifyRepository(manifest, {
            workspaceRoot,
            benchmarksRoot,
            braidCommand: defaultBraidCommand(workspaceRoot),
            keepWorkdir: options.keepWorkdirs ?? false,
          }),
        );
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      if (
        results.some(
          ({ outcome, recordedStatus }) =>
            outcome === "rejected" || outcome !== recordedStatus,
        )
      )
        process.exitCode = 2;
    },
  );

repositories
  .command("refresh")
  .description("Explicitly download and reverify one pinned repository")
  .argument("<id>")
  .action(async (id: string) => {
    const manifest = await loadRepositoryManifest(benchmarksRoot, id);
    const verification = await refreshRepositoryCache(
      manifest,
      repositoryCacheRoot,
    );
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  });

const common = (command: Command, defaultSuite: string): Command =>
  command
    .requiredOption("--suite <suite>", "suite ID", defaultSuite)
    .option("--case <case-id>", "run one case")
    .option("--output <directory>", "report directory")
    .option("--braid-command <command>", "Braid executable command")
    .option("--keep-workdirs", "keep temporary fixture copies")
    .option("--verbose", "write progress to stderr")
    .option("--json", "write one JSON document to stdout")
    .option("--smoke", "run smoke cases only");

common(
  program.command("run").description("Run proposal benchmarks"),
  "phase-2-core",
).action(async (options: CommonOptions) => {
  await execute("proposal", options);
});

common(
  program.command("compare").description("Run static before/after comparisons"),
  "static-comparison",
).action(async (options: CommonOptions) => {
  await execute("static-comparison", options);
});

program
  .command("report")
  .description("Regenerate and print a report")
  .argument("<run-directory>")
  .option("--markdown", "print Markdown instead of console output")
  .action(async (runDirectory: string, options: { markdown?: boolean }) => {
    const run = await loadRun(path.resolve(runDirectory));
    await writeReports(run, path.resolve(runDirectory));
    process.stdout.write(
      options.markdown ? markdownReport(run) : consoleReport(run),
    );
  });

program
  .command("compare-runs")
  .description("Compare baseline and candidate benchmark runs")
  .argument("<baseline-run>")
  .argument("<candidate-run>")
  .option(
    "--allow-incompatible",
    "show metrics despite incompatible frozen inputs",
  )
  .option("--output <directory>", "comparison report directory")
  .option("--policy <name>", "regression policy", "default")
  .option("--json", "write comparison JSON to stdout")
  .option("--markdown", "write comparison Markdown to stdout")
  .action(
    async (
      baselineRun: string,
      candidateRun: string,
      options: ComparisonOptions,
    ) => {
      const comparison = compareBenchmarkRuns(
        await loadRun(path.resolve(baselineRun)),
        await loadRun(path.resolve(candidateRun)),
        await loadRegressionPolicy(benchmarksRoot, options.policy),
        options.allowIncompatible ?? false,
      );
      if (options.output)
        await writeComparisonReports(comparison, path.resolve(options.output));
      printComparison(comparison, options);
    },
  );

const baseline = program
  .command("baseline")
  .description("Manage golden baselines");

baseline
  .command("create")
  .requiredOption("--run <run-directory>", "source run directory")
  .requiredOption("--name <name>", "baseline name")
  .option("--force", "confirm creation or replacement")
  .action(async (options: { run: string; name: string; force?: boolean }) => {
    const created = await createGoldenBaseline(
      baselinesRoot,
      await loadRun(path.resolve(options.run)),
      options.name,
      options.force ?? false,
    );
    process.stdout.write(
      `Created baseline ${created.name} from ${created.createdFromRunId}\n`,
    );
  });

baseline.command("list").action(async () => {
  process.stdout.write(
    `${(await listGoldenBaselines(baselinesRoot)).join("\n")}\n`,
  );
});

baseline
  .command("show")
  .argument("<name>")
  .action(async (name: string) => {
    process.stdout.write(
      `${JSON.stringify(await loadGoldenBaseline(baselinesRoot, name), null, 2)}\n`,
    );
  });

program
  .command("compare-baseline")
  .description("Compare a golden baseline with a candidate run")
  .argument("<name>")
  .argument("<candidate-run>")
  .option("--allow-incompatible", "show metrics despite incompatible inputs")
  .option("--output <directory>", "comparison report directory")
  .option("--policy <name>", "regression policy", "default")
  .option("--json", "write comparison JSON to stdout")
  .option("--markdown", "write comparison Markdown to stdout")
  .action(
    async (name: string, candidateRun: string, options: ComparisonOptions) => {
      const golden = await loadGoldenBaseline(baselinesRoot, name);
      const candidate = await loadRun(path.resolve(candidateRun));
      const comparison = compareBenchmarkSummaries(
        {
          runId: golden.createdFromRunId,
          manifest: golden.manifest,
          summary: golden.summary,
        },
        {
          runId: candidate.runId,
          manifest: candidate.manifest,
          summary: benchmarkSummary(candidate),
        },
        await loadRegressionPolicy(benchmarksRoot, options.policy),
        options.allowIncompatible ?? false,
      );
      if (options.output)
        await writeComparisonReports(comparison, path.resolve(options.output));
      printComparison(comparison, options);
    },
  );

program
  .command("iteration")
  .description("Run and compare baseline and candidate Braid executables")
  .requiredOption("--suite <suite>", "suite ID", "phase-2-core")
  .requiredOption("--baseline-braid <path>", "baseline Braid executable or .js")
  .requiredOption(
    "--candidate-braid <path>",
    "candidate Braid executable or .js",
  )
  .option("--output <directory>", "iteration report directory")
  .option("--case <case-id>", "run one case")
  .option("--policy <name>", "regression policy", "default")
  .option("--smoke", "run smoke cases only")
  .option("--verbose", "write progress to stderr")
  .action(
    async (options: {
      suite: string;
      baselineBraid: string;
      candidateBraid: string;
      output?: string;
      case?: string;
      policy: string;
      smoke?: boolean;
      verbose?: boolean;
    }) => {
      const suite = await loadSuite(benchmarksRoot, options.suite);
      const kind = suiteKind(suite);
      const output = path.resolve(
        options.output ??
          path.join(
            benchmarksRoot,
            "results",
            `iteration-${new Date().toISOString().replaceAll(/[-:.]/gu, "")}`,
          ),
      );
      const run = async (
        name: "baseline" | "candidate",
        command: readonly string[],
      ): Promise<BenchmarkRun> => {
        const result = await runBenchmarkSuite(suite, {
          workspaceRoot,
          benchmarksRoot,
          braidCommand: command,
          ...(options.case ? { caseId: options.case } : {}),
          ...(options.smoke === undefined ? {} : { smoke: options.smoke }),
          keepWorkdirs: false,
          ...(options.verbose === undefined
            ? {}
            : { verbose: options.verbose }),
          kind,
        });
        await writeReports(result, path.join(output, name));
        return result;
      };
      const baselineRun = await run(
        "baseline",
        executableCommand(options.baselineBraid),
      );
      const candidateRun = await run(
        "candidate",
        executableCommand(options.candidateBraid),
      );
      const comparison = compareBenchmarkRuns(
        baselineRun,
        candidateRun,
        await loadRegressionPolicy(benchmarksRoot, options.policy),
      );
      await writeComparisonReports(comparison, output);
      printComparison(comparison, {});
    },
  );

program
  .command("regression")
  .description("Run the smoke suite against a tracked correctness baseline")
  .option("--suite <suite>", "suite ID", "phase-2-core")
  .option("--baseline <name>", "golden baseline", "phase-2-core-smoke")
  .option("--output <directory>", "report directory")
  .option("--policy <name>", "regression policy", "default")
  .action(
    async (options: {
      suite: string;
      baseline: string;
      output?: string;
      policy: string;
    }) => {
      const suite = await loadSuite(benchmarksRoot, options.suite);
      const run = await runBenchmarkSuite(suite, {
        workspaceRoot,
        benchmarksRoot,
        braidCommand: defaultBraidCommand(workspaceRoot),
        smoke: true,
        keepWorkdirs: false,
        kind: suiteKind(suite),
      });
      const output = path.resolve(
        options.output ?? path.join(benchmarksRoot, "results", run.runId),
      );
      await writeReports(run, path.join(output, "candidate"));
      const golden = await loadGoldenBaseline(baselinesRoot, options.baseline);
      const comparison = compareBenchmarkSummaries(
        {
          runId: golden.createdFromRunId,
          manifest: golden.manifest,
          summary: golden.summary,
        },
        {
          runId: run.runId,
          manifest: run.manifest,
          summary: benchmarkSummary(run),
        },
        await loadRegressionPolicy(benchmarksRoot, options.policy),
      );
      await writeComparisonReports(comparison, output);
      printComparison(comparison, {});
    },
  );

program.exitOverride();
for (const command of program.commands) command.exitOverride();
try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError)
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
