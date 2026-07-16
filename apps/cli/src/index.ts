#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { BraidError } from "@braid/shared";
import { analyzeCommand } from "./commands/analyze.js";
import { initCommand } from "./commands/init.js";
import {
  growthCheckCommand,
  growthContextCommand,
  growthFinalCommand,
  growthHookCommand,
  growthInstallCodexCommand,
  growthResetCommand,
  growthStatusCommand,
  growthUninstallCodexCommand,
} from "./commands/growth.js";
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
  .version("0.4.0");

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

const growth = program
  .command("growth")
  .description("Guard architecture changes during an ordinary coding session");

growth
  .command("context")
  .description("Initialize or show concise session architecture guidance")
  .option("--path <path>", "target project", ".")
  .option("--session <id>", "Growth Mode session ID")
  .option("--json", "write context JSON")
  .action(growthContextCommand);

growth
  .command("check")
  .description("Evaluate the current state relative to the session baseline")
  .option("--path <path>", "target project", ".")
  .option("--session <id>", "Growth Mode session ID")
  .option("--json", "write report JSON")
  .action(growthCheckCommand);

growth
  .command("final")
  .description("Apply the finite Stop-equivalent final policy")
  .option("--path <path>", "target project", ".")
  .option("--session <id>", "Growth Mode session ID")
  .option("--json", "write final result JSON")
  .action(growthFinalCommand);

growth
  .command("status")
  .description("Show session, installation, and Codex capability status")
  .option("--path <path>", "target project", ".")
  .option("--session <id>", "Growth Mode session ID")
  .option("--codex <executable>", "Codex executable", "codex")
  .option("--json", "write status JSON")
  .action(growthStatusCommand);

growth
  .command("reset")
  .description("Reset only Braid-owned ephemeral state for one session")
  .option("--path <path>", "target project", ".")
  .option("--session <id>", "Growth Mode session ID")
  .option("--confirm <id>", "repeat the exact session ID")
  .option("--json", "write reset result JSON")
  .action(growthResetCommand);

const growthInstall = growth
  .command("install")
  .description("Install repository-local Growth Mode integration");

growthInstall
  .command("codex")
  .description("Merge Braid-owned handlers into repository Codex hooks")
  .option("--path <path>", "target project", ".")
  .option("--codex <executable>", "Codex executable", "codex")
  .option("--dry-run", "show the intended installation without writing")
  .option("--confirm", "confirm repository-local hook installation")
  .option("--json", "write installation JSON")
  .action(growthInstallCodexCommand);

const growthUninstall = growth
  .command("uninstall")
  .description("Remove repository-local Growth Mode integration");

growthUninstall
  .command("codex")
  .description("Remove only Braid-owned Codex hook handlers")
  .option("--path <path>", "target project", ".")
  .option("--dry-run", "show the intended removal without writing")
  .option("--json", "write uninstall JSON")
  .action(growthUninstallCodexCommand);

growth
  .command("hook", { hidden: true })
  .description("Internal Codex command-hook entrypoint")
  .action(growthHookCommand);

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
