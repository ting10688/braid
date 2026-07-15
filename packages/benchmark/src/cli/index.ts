#!/usr/bin/env node
import { glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadSuite } from "../fixtures/fixture-loader.js";
import {
  compareRunReport,
  consoleReport,
  loadRun,
  markdownReport,
  writeReports,
} from "../reports/reporters.js";
import {
  defaultBraidCommand,
  runBenchmarkSuite,
} from "../runner/benchmark-runner.js";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const benchmarksRoot = path.join(workspaceRoot, "benchmarks");

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

const parseCommand = (input: string | undefined): string[] => {
  if (!input) return defaultBraidCommand(workspaceRoot);
  const parts = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
  if (parts.length === 0) throw new Error("--braid-command must not be empty");
  return parts;
};

const execute = async (
  kind: "proposal" | "static-comparison",
  options: CommonOptions,
): Promise<void> => {
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
};

const program = new Command()
  .name("braid-bench")
  .description("Independent reproducible benchmarks for Braid")
  .version("0.1.0");

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
          (suite) => `${suite.id}\t${suite.title}\t${suite.cases.length} cases`,
        )
        .join("\n")}\n`,
    );
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
).action((options: CommonOptions) => execute("proposal", options));

common(
  program.command("compare").description("Run static before/after comparisons"),
  "static-comparison",
).action((options: CommonOptions) => execute("static-comparison", options));

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
  .description("Compare two compatible benchmark runs")
  .argument("<run-a>")
  .argument("<run-b>")
  .option("--allow-incompatible", "override suite compatibility checks")
  .action(
    async (
      runA: string,
      runB: string,
      options: { allowIncompatible?: boolean },
    ) => {
      process.stdout.write(
        compareRunReport(
          await loadRun(path.resolve(runA)),
          await loadRun(path.resolve(runB)),
          options.allowIncompatible ?? false,
        ),
      );
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
