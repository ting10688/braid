#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { BraidError } from "@braid/shared";
import { analyzeCommand } from "./commands/analyze.js";
import { initCommand } from "./commands/init.js";
import { proposeCommand } from "./commands/propose.js";
import {
  migrateDiffCommand,
  migrateDiscardCommand,
  migrateInspectCommand,
  migrateListCommand,
  migratePlanCommand,
  migrateRunCommand,
  migrateSuggestCommand,
  migrateStatusCommand,
} from "./commands/migrate.js";

const program = new Command()
  .name("braid")
  .description("Continuous architecture evolution for growing codebases")
  .version("0.3.2");

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

const migrate = program
  .command("migrate")
  .description("Plan and execute approved isolated migrations");

migrate
  .command("plan")
  .description("Show a deterministic migration plan without a worktree")
  .argument("<proposal-id>")
  .option("--path <path>", "target project", ".")
  .option("--json", "write plan JSON")
  .action(migratePlanCommand);

migrate
  .command("run")
  .description("Run an explicitly approved migration in an isolated worktree")
  .argument("<proposal-id>")
  .option("--path <path>", "target project", ".")
  .option("--approve <proposal-id>", "repeat the exact proposal ID")
  .option("--executor <executor>", "migration executor", "codex")
  .option("--model <model>", "Codex model")
  .option("--reasoning-effort <value>", "Codex reasoning effort")
  .option("--timeout <milliseconds>", "executor timeout")
  .option("--json", "write execution record JSON")
  .option("--no-commit", "retain validated changes without a candidate commit")
  .action(migrateRunCommand);

migrate
  .command("suggest")
  .description("Suggest an advisory repair for a not-ready proposal")
  .argument("<proposal-id>")
  .option("--path <path>", "target project", ".")
  .option("--json", "write repair suggestion JSON")
  .action(migrateSuggestCommand);

migrate
  .command("list")
  .description("List migration execution records")
  .option("--path <path>", "target project", ".")
  .option("--json", "write record JSON")
  .action(migrateListCommand);

migrate
  .command("status")
  .description("Show one migration execution status")
  .argument("<execution-id>")
  .option("--path <path>", "target project", ".")
  .option("--json", "write record JSON")
  .action(migrateStatusCommand);

migrate
  .command("inspect")
  .description("Show the portable plan and execution record")
  .argument("<execution-id>")
  .option("--path <path>", "target project", ".")
  .action(migrateInspectCommand);

migrate
  .command("diff")
  .description("Show the retained candidate patch")
  .argument("<execution-id>")
  .option("--path <path>", "target project", ".")
  .action(migrateDiffCommand);

migrate
  .command("discard")
  .description("Safely remove an execution-owned worktree and branch")
  .argument("<execution-id>")
  .option("--path <path>", "target project", ".")
  .option("--confirm <execution-id>", "repeat the exact execution ID")
  .option("--json", "write discarded record JSON")
  .action(migrateDiscardCommand);

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
