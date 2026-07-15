import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  codexMigrationSummarySchema,
  migrationExecutionPlanSchema,
  type CodexMigrationSummary,
  type MigrationExecutionPlan,
} from "@braid/core";
import { CODEX_MIGRATION_SUMMARY_JSON_SCHEMA } from "../prompt-builder.js";
import { redactSensitiveText } from "../safety.js";
import type {
  ExecutorContext,
  ExecutorEnvironment,
  ExecutorEvent,
  ExecutorResult,
  MigrationExecutor,
} from "./executor.js";

const execFileAsync = promisify(execFile);

export type CodexApprovalPolicyArgument =
  "ask-for-approval-flag" | "config-override";
export type CodexWorkingDirectoryArgument = "--cd" | "-C";

export interface CodexExecutorEnvironment extends ExecutorEnvironment {
  kind: "codex";
  approvalPolicyArgument: CodexApprovalPolicyArgument;
  workingDirectoryArgument: CodexWorkingDirectoryArgument;
}

export type CodexProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type CodexInspector = (
  executable: string,
  arguments_: readonly string[],
) => Promise<string>;

export interface CodexExecutorOptions {
  executable?: string;
  spawnProcess?: CodexProcessSpawner;
  inspectExecutable?: CodexInspector;
  terminationGraceMs?: number;
}

const defaultSpawner: CodexProcessSpawner = (executable, arguments_, options) =>
  spawn(executable, [...arguments_], options);

const defaultInspector: CodexInspector = async (executable, arguments_) => {
  const { stdout } = await execFileAsync(executable, [...arguments_], {
    encoding: "utf8",
  });
  return stdout;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const redactSecrets = (
  value: string,
  privatePaths: readonly string[] = [],
): string =>
  redactSensitiveText(
    privatePaths
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .reduce(
        (redacted, privatePath) =>
          redacted.replaceAll(privatePath, "<private>"),
        value,
      ),
  );

const timestampFrom = (event: Record<string, unknown>): string | undefined =>
  typeof event.timestamp === "string" ? event.timestamp : undefined;

const withTimestamp = (
  event: ExecutorEvent,
  source: Record<string, unknown>,
): ExecutorEvent => {
  const timestamp = timestampFrom(source);
  return timestamp ? { ...event, timestamp } : event;
};

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const usageEvent = (
  event: Record<string, unknown>,
): ExecutorEvent | undefined => {
  if (event.type !== "turn.completed" || !isRecord(event.usage)) return;
  const inputTokens = tokenCount(
    event.usage.input_tokens ?? event.usage.inputTokens,
  );
  const cachedInputTokens = tokenCount(
    event.usage.cached_input_tokens ?? event.usage.cachedInputTokens,
  );
  const outputTokens = tokenCount(
    event.usage.output_tokens ?? event.usage.outputTokens,
  );
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined
  )
    return;
  return withTimestamp(
    {
      type: "usage",
      usage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      },
    },
    event,
  );
};

const commandEvent = (
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  privatePaths: readonly string[],
): ExecutorEvent | undefined => {
  if (item.type !== "command_execution") return;
  const command = Array.isArray(item.command)
    ? item.command
        .filter((part): part is string => typeof part === "string")
        .map((part) => redactSecrets(part, privatePaths))
    : typeof item.command === "string"
      ? [redactSecrets(item.command, privatePaths)]
      : [];
  if (command.length === 0) return;
  return withTimestamp({ type: "command", command }, event);
};

const fileChangeEvents = (
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  worktreePath: string,
): ExecutorEvent[] => {
  if (item.type !== "file_change") return [];
  const paths = [
    ...(typeof item.path === "string" ? [item.path] : []),
    ...(Array.isArray(item.changes)
      ? item.changes.flatMap((change) =>
          isRecord(change) && typeof change.path === "string"
            ? [change.path]
            : [],
        )
      : []),
  ];
  const relativePaths = paths.flatMap((changedPath) => {
    const relativePath = path.relative(
      worktreePath,
      path.isAbsolute(changedPath)
        ? changedPath
        : path.resolve(worktreePath, changedPath),
    );
    return relativePath &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
      ? [relativePath.split(path.sep).join("/")]
      : [];
  });
  return [...new Set(relativePaths)].map((changedPath) =>
    withTimestamp({ type: "file-change", path: changedPath }, event),
  );
};

const parseSummary = (
  message: string,
  privatePaths: readonly string[],
): CodexMigrationSummary | undefined => {
  try {
    const parsed = codexMigrationSummarySchema.safeParse(JSON.parse(message));
    if (!parsed.success) return;
    return codexMigrationSummarySchema.parse({
      ...parsed.data,
      testsRun: parsed.data.testsRun.map((test) =>
        redactSecrets(test, privatePaths),
      ),
      summary: redactSecrets(parsed.data.summary, privatePaths),
      unresolvedConcerns: parsed.data.unresolvedConcerns.map((concern) =>
        redactSecrets(concern, privatePaths),
      ),
    });
  } catch {
    return;
  }
};

const filterJsonLines = (
  stdout: string,
  worktreePath: string,
  privatePaths: readonly string[],
): { events: ExecutorEvent[]; summary?: CodexMigrationSummary } => {
  const events: ExecutorEvent[] = [];
  let finalMessage: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const usage = usageEvent(event);
    if (usage) events.push(usage);
    if (event.type !== "item.completed" || !isRecord(event.item)) continue;
    const command = commandEvent(event.item, event, privatePaths);
    if (command) events.push(command);
    events.push(...fileChangeEvents(event.item, event, worktreePath));
    if (
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
      events.push(
        withTimestamp(
          {
            type: "message",
            message: redactSecrets(finalMessage, privatePaths),
          },
          event,
        ),
      );
    }
  }
  const summary = finalMessage
    ? parseSummary(finalMessage, privatePaths)
    : undefined;
  return { events, ...(summary ? { summary } : {}) };
};

const terminateProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  if (process.platform === "win32" && child.pid !== undefined) {
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
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and this signal.
    }
  }
  child.kill(signal);
};

interface RawProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export class CodexExecutor implements MigrationExecutor {
  readonly kind = "codex" as const;
  readonly #executable: string;
  readonly #spawnProcess: CodexProcessSpawner;
  readonly #inspectExecutable: CodexInspector;
  readonly #terminationGraceMs: number;
  #inspection?: Promise<{
    executableVersion: string;
    approvalPolicyArgument: CodexApprovalPolicyArgument;
    workingDirectoryArgument: CodexWorkingDirectoryArgument;
  }>;

  constructor(options: CodexExecutorOptions = {}) {
    this.#executable = options.executable ?? "codex";
    this.#spawnProcess = options.spawnProcess ?? defaultSpawner;
    this.#inspectExecutable = options.inspectExecutable ?? defaultInspector;
    this.#terminationGraceMs = options.terminationGraceMs ?? 1_000;
  }

  async #inspect(): Promise<{
    executableVersion: string;
    approvalPolicyArgument: CodexApprovalPolicyArgument;
    workingDirectoryArgument: CodexWorkingDirectoryArgument;
  }> {
    this.#inspection ??= Promise.all([
      this.#inspectExecutable(this.#executable, ["--version"]),
      this.#inspectExecutable(this.#executable, ["exec", "--help"]),
    ]).then(([version, help]) => {
      const workingDirectoryArgument = help.includes("--cd")
        ? "--cd"
        : /(?:^|\s)-C(?:[ ,]|$)/mu.test(help)
          ? "-C"
          : undefined;
      if (!workingDirectoryArgument)
        throw new Error(
          "Installed Codex CLI has no supported --cd or -C worktree flag",
        );
      return {
        executableVersion: version.trim(),
        approvalPolicyArgument: help.includes("--ask-for-approval")
          ? "ask-for-approval-flag"
          : "config-override",
        workingDirectoryArgument,
      };
    });
    return this.#inspection;
  }

  async inspect(): Promise<CodexExecutorEnvironment> {
    const inspection = await this.#inspect();
    return {
      kind: "codex",
      executableVersion: inspection.executableVersion,
      approvalPolicyArgument: inspection.approvalPolicyArgument,
      workingDirectoryArgument: inspection.workingDirectoryArgument,
      sandbox: "workspace-write",
    };
  }

  async #run(
    arguments_: readonly string[],
    context: ExecutorContext,
  ): Promise<RawProcessResult> {
    return new Promise((resolve, reject) => {
      const child = this.#spawnProcess(this.#executable, arguments_, {
        cwd: context.worktreePath,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.stdout || !child.stderr || !child.stdin) {
        child.kill("SIGKILL");
        reject(new Error("Codex process must expose separate stdio pipes"));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let closeCode: number | null | undefined;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.stdin.on("error", () => undefined);

      const timeout = setTimeout(() => {
        timedOut = true;
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          terminateProcessGroup(child, "SIGKILL");
          if (closeCode !== undefined)
            finish(() =>
              resolve({
                exitCode: closeCode!,
                timedOut,
                stdout,
                stderr,
              }),
            );
        }, this.#terminationGraceMs);
        terminateProcessGroup(child, "SIGTERM");
      }, context.timeoutMs);

      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        result();
      };
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode) => {
        closeCode = exitCode;
        if (!timedOut) {
          terminateProcessGroup(child, "SIGKILL");
          finish(() => resolve({ exitCode, timedOut, stdout, stderr }));
        } else if (forceTimer === undefined)
          finish(() => resolve({ exitCode, timedOut, stdout, stderr }));
      });
      child.stdin.end(context.prompt);
    });
  }

  async execute(
    unparsedPlan: MigrationExecutionPlan,
    context: ExecutorContext,
  ): Promise<ExecutorResult> {
    const plan = migrationExecutionPlanSchema.parse(unparsedPlan);
    if (plan.executor.kind !== "codex")
      throw new Error("CodexExecutor requires a codex execution plan");
    const inspection = await this.#inspect();
    const schemaDirectory = await mkdtemp(
      path.join(tmpdir(), "braid-codex-summary-"),
    );
    const schemaPath = path.join(schemaDirectory, "schema.json");
    try {
      await writeFile(
        schemaPath,
        `${JSON.stringify(CODEX_MIGRATION_SUMMARY_JSON_SCHEMA)}\n`,
        { mode: 0o600 },
      );
      const approvalArguments =
        inspection.approvalPolicyArgument === "ask-for-approval-flag"
          ? ["--ask-for-approval", "never"]
          : ["-c", 'approval_policy="never"'];
      const arguments_ = [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        ...approvalArguments,
        inspection.workingDirectoryArgument,
        context.worktreePath,
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        ...(plan.executor.requestedModel
          ? ["--model", plan.executor.requestedModel]
          : []),
        ...(plan.executor.requestedReasoningEffort
          ? [
              "-c",
              `model_reasoning_effort=${JSON.stringify(
                plan.executor.requestedReasoningEffort,
              )}`,
            ]
          : []),
        "--output-schema",
        schemaPath,
        "-",
      ];
      const raw = await this.#run(arguments_, context);
      const privatePaths = [schemaDirectory, context.worktreePath, homedir()];
      const filtered = filterJsonLines(
        raw.stdout,
        context.worktreePath,
        privatePaths,
      );
      const stdout = filtered.events
        .map((event) => JSON.stringify(event))
        .join("\n");
      return {
        exitCode: raw.exitCode,
        timedOut: raw.timedOut,
        stdout: stdout ? `${stdout}\n` : "",
        stderr: redactSecrets(raw.stderr, privatePaths),
        events: filtered.events,
        ...(filtered.summary ? { summary: filtered.summary } : {}),
      };
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true });
    }
  }
}
