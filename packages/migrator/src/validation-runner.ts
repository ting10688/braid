import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  validationCommandSchema,
  validationResultSchema,
  type ValidationCommand,
  type ValidationResult,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";

const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const DIRECT_MUTATION_EXECUTABLES = new Set([
  "curl",
  "ftp",
  "gh",
  "git",
  "hub",
  "nc",
  "netcat",
  "scp",
  "sftp",
  "ssh",
  "wget",
]);
const PROCESS_WRAPPERS = new Set([
  "chroot",
  "doas",
  "env",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);
const INSTALL_ACTIONS = new Set([
  "add",
  "ci",
  "i",
  "import",
  "install",
  "link",
  "remove",
  "rm",
  "uninstall",
  "unlink",
  "up",
  "update",
]);

export interface RunValidationCommandsInput {
  worktreeRoot: string;
  commands: readonly ValidationCommand[];
}

export interface ValidationSummary {
  passed: boolean;
  results: ValidationResult[];
}

interface CapturedOutput {
  append(chunk: Buffer | string): void;
  value(): string;
  readonly truncated: boolean;
}

const executableName = (value: string): string =>
  path
    .basename(value)
    .toLowerCase()
    .replace(/\.exe$/u, "");

export const assertSafeValidationCommand = (
  input: ValidationCommand,
): ValidationCommand => {
  let command: ValidationCommand;
  try {
    command = validationCommandSchema.parse(input);
  } catch (error) {
    throw new MigrationSafetyError(
      "Validation command is not a trusted executable-and-argument definition",
      9,
      "unsafe-validation-command",
      { cause: error },
    );
  }
  const executable = executableName(command.executable);
  if (SHELL_EXECUTABLES.has(executable))
    throw new MigrationSafetyError(
      `Shell executables are forbidden in migration validation: ${command.executable}`,
      9,
      "unsafe-validation-command",
    );
  if (DIRECT_MUTATION_EXECUTABLES.has(executable))
    throw new MigrationSafetyError(
      `Direct Git and network tools are forbidden in migration validation: ${command.executable}`,
      9,
      "unsafe-validation-command",
    );
  if (PROCESS_WRAPPERS.has(executable))
    throw new MigrationSafetyError(
      `Command-wrapper executables are forbidden in migration validation: ${command.executable}`,
      9,
      "unsafe-validation-command",
    );
  const actions = command.arguments.map((argument) => argument.toLowerCase());
  const installsDependencies =
    executable === "npx" ||
    executable === "bunx" ||
    executable === "corepack" ||
    (executable === "yarn" && actions.length === 0) ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) &&
      actions.includes("exec")) ||
    (["pnpm", "yarn"].includes(executable) && actions.includes("dlx")) ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) &&
      actions.some((action) => INSTALL_ACTIONS.has(action)));
  if (installsDependencies)
    throw new MigrationSafetyError(
      `Dependency installation is forbidden during migration validation: ${command.executable} ${command.arguments.join(" ")}`,
      9,
      "dependency-install-forbidden",
    );
  if (
    ["node", "nodejs"].includes(executable) &&
    command.arguments.some(
      (argument) =>
        ["-e", "--eval", "-p", "--print"].includes(argument) ||
        argument.startsWith("--eval=") ||
        argument.startsWith("--print=") ||
        /^-[ep].+/u.test(argument),
    )
  )
    throw new MigrationSafetyError(
      "Inline Node.js evaluation is forbidden in migration validation",
      9,
      "unsafe-validation-command",
    );
  return command;
};

const capture = (limit: number): CapturedOutput => {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (kept >= limit) return;
      const retained = buffer.subarray(0, limit - kept);
      chunks.push(retained);
      kept += retained.length;
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
    get truncated() {
      return total > limit;
    },
  };
};

const terminateProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      [
        "/pid",
        String(child.pid),
        "/t",
        ...(signal === "SIGKILL" ? ["/f"] : []),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    killer.on("error", () => child.kill(signal));
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
};

const confinedWorkingDirectory = async (
  worktreeRoot: string,
  workingDirectory: string,
): Promise<string> => {
  let root: string;
  let candidate: string;
  try {
    root = await realpath(worktreeRoot);
    candidate = await realpath(path.resolve(root, workingDirectory));
  } catch (error) {
    throw new MigrationSafetyError(
      `Validation working directory does not exist: ${workingDirectory}`,
      9,
      "invalid-validation-cwd",
      { cause: error },
    );
  }
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
    throw new MigrationSafetyError(
      `Validation working directory escapes the execution worktree: ${workingDirectory}`,
      9,
      "validation-cwd-escape",
    );
  return candidate;
};

const runCommand = async (
  root: string,
  command: ValidationCommand,
): Promise<ValidationResult> => {
  const cwd = await confinedWorkingDirectory(root, command.workingDirectory);
  const stdout = capture(command.stdoutLimit);
  const stderr = capture(command.stderrLimit);
  const started = performance.now();

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.arguments, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let spawnFailed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeCode: number | null | undefined;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", (error) => {
      spawnFailed = true;
      stderr.append(error.message);
    });
    const resultFor = (code: number | null): ValidationResult => {
      const failed = spawnFailed || code !== 0;
      return validationResultSchema.parse({
        commandId: command.id,
        stage: command.stage,
        status: timedOut
          ? "timeout"
          : failed
            ? command.required
              ? "failed"
              : "warning"
            : "passed",
        required: command.required,
        exitCode: code,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(resultFor(code));
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        terminateProcessGroup(child, "SIGKILL");
        if (closeCode !== undefined) finish(closeCode);
      }, 1_000);
    }, command.timeoutMs);
    child.once("close", (code) => {
      closeCode = code;
      if (!timedOut) {
        terminateProcessGroup(child, "SIGKILL");
        finish(code);
      } else if (killTimer === undefined) finish(code);
    });
  });
};

export const runValidationCommands = async (
  input: RunValidationCommandsInput,
): Promise<ValidationSummary> => {
  if (input.commands.length === 0)
    throw new MigrationSafetyError(
      "At least one trusted validation command is required",
      9,
      "missing-validation-commands",
    );
  const commands = input.commands.map(assertSafeValidationCommand);
  const results: ValidationResult[] = [];
  for (const command of commands)
    results.push(await runCommand(input.worktreeRoot, command));
  return {
    passed: results.every(
      (result) =>
        result.status !== "timeout" &&
        (!result.required || result.status !== "failed"),
    ),
    results,
  };
};
