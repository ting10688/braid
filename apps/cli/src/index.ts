#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { BraidError } from "@braid/shared";
import { analyzeCommand } from "./commands/analyze.js";
import { initCommand } from "./commands/init.js";
import { proposeCommand } from "./commands/propose.js";

const program = new Command()
  .name("braid")
  .description("Continuous architecture evolution for growing codebases")
  .version("0.2.0");

program
  .command("init")
  .description("Create project-local Braid configuration and state")
  .argument("[path]", "target project", ".")
  .option("--force", "replace existing configuration")
  .action(initCommand);

program
  .command("analyze")
  .description("Create a deterministic architecture snapshot")
  .argument("[path]", "target project", ".")
  .option("--json", "write only the snapshot JSON to stdout")
  .option("--no-save", "do not persist the snapshot")
  .action(analyzeCommand);

program
  .command("propose")
  .description("Generate deterministic migration proposals")
  .argument("[path]", "target project", ".")
  .option("--json", "write only proposal JSON to stdout")
  .option("--no-save", "do not persist the snapshot or proposals")
  .option("--limit <number>", "maximum proposals to return")
  .option("--type <type>", "filter by extract-module or break-cycle")
  .option("--snapshot <snapshot-id>", "use an existing snapshot")
  .action(proposeCommand);

program.exitOverride();
for (const command of program.commands) command.exitOverride();

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    const exitCode = error instanceof BraidError ? error.exitCode : 1;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = exitCode;
  }
}
