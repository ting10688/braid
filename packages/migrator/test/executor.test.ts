import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { migrationExecutionPlanSchema } from "@braid/core";
import {
  CodexExecutor,
  type CodexInspector,
  type CodexProcessSpawner,
} from "../src/executors/codex-executor.js";
import { ScriptedTestExecutor } from "../src/executors/scripted-test-executor.js";

const planFor = (kind: "codex" | "scripted-test" = "codex") =>
  migrationExecutionPlanSchema.parse({
    schemaVersion: 1,
    planId: "PL-0123456789abcdef",
    proposalId: "P-EM-a18d42f3",
    proposalType: "extract-module",
    repository: {
      baseCommit: "1".repeat(40),
      sourceFingerprint: "2".repeat(64),
      configHash: "3".repeat(64),
      snapshotId: "S-a18d42f3",
    },
    approval: { requiredProposalId: "P-EM-a18d42f3" },
    scope: {
      allowedExistingFiles: ["src/orders/order-service.ts"],
      allowedNewFilePatterns: ["src/notification/**"],
      allowedTestFiles: [],
      forbiddenFiles: ["package.json", "pnpm-lock.yaml"],
      maximumChangedFiles: 4,
    },
    expectedChange: {
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      suggestedModule: "notification",
      destinationDirectory: "src/notification",
      symbols: ["notificationLog", "sentNotifications"],
      predictedImpact: { simulated: [], estimated: [], unknowns: [] },
    },
    validation: {
      commands: [
        {
          id: "test",
          stage: "unit-test",
          executable: "pnpm",
          arguments: ["test"],
        },
      ],
    },
    executor: {
      kind,
      ...(kind === "codex"
        ? {
            requestedModel: "gpt-5.4",
            requestedReasoningEffort: "high",
          }
        : {}),
      timeoutMs: 60_000,
      sandbox: "workspace-write",
    },
  });

interface Invocation {
  executable: string;
  arguments_: string[];
  options: SpawnOptions;
}

const mockScript = (
  lines: readonly string[],
  stderr = "",
  exitCode = 0,
): string => `
const lines = ${JSON.stringify(lines)};
process.stdin.resume();
process.stdin.on("end", () => {
  for (const line of lines) process.stdout.write(line + "\\n");
  process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = ${exitCode};
});
`;

const spawnerFor =
  (script: string, invocations: Invocation[]): CodexProcessSpawner =>
  (executable, arguments_, options) => {
    invocations.push({ executable, arguments_: [...arguments_], options });
    return spawn(
      process.execPath,
      ["-e", script, "mock-codex", ...arguments_],
      options,
    );
  };

const inspectorFor =
  (supportsApprovalFlag: boolean): CodexInspector =>
  async (_executable, arguments_) =>
    arguments_[0] === "--version"
      ? "codex-cli 0.test.0\n"
      : supportsApprovalFlag
        ? "--ask-for-approval <POLICY>\n--cd <DIR>\n"
        : "--cd <DIR>\n";

const context = (timeoutMs = 1_000) => ({
  worktreePath: process.cwd(),
  prompt: "bounded prompt",
  timeoutMs,
});

describe("CodexExecutor", () => {
  it("uses argument arrays, the supported approval flag, and filtered JSONL", async () => {
    const summary = JSON.stringify({
      status: "completed",
      changedFiles: ["src/orders/order-service.ts"],
      addedFiles: ["src/notification/index.ts"],
      testsRun: ["pnpm test"],
      summary: "Extracted notifications.",
      unresolvedConcerns: [],
    });
    const lines = [
      JSON.stringify({ type: "reasoning", text: "hidden-reasoning-secret" }),
      JSON.stringify({ type: "auth", token: "hidden-auth-secret" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: ["pnpm", "test"] },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "src/notification/index.ts", kind: "add" }],
        },
      }),
      "malformed-json",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: summary },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 25,
          output_tokens: 40,
        },
      }),
    ];
    const invocations: Invocation[] = [];
    const executor = new CodexExecutor({
      executable: "mock-codex",
      inspectExecutable: inspectorFor(true),
      spawnProcess: spawnerFor(mockScript(lines, "warning\n"), invocations),
    });

    await expect(executor.inspect()).resolves.toMatchObject({
      executableVersion: "codex-cli 0.test.0",
      approvalPolicyArgument: "ask-for-approval-flag",
      workingDirectoryArgument: "--cd",
      sandbox: "workspace-write",
    });
    const result = await executor.execute(planFor(), context());
    const invocation = invocations[0]!;

    expect(invocation.executable).toBe("mock-codex");
    expect(invocation.arguments_.slice(0, 9)).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--cd",
      process.cwd(),
    ]);
    expect(invocation.arguments_).toContain("--model");
    expect(invocation.arguments_).toContain("gpt-5.4");
    expect(invocation.arguments_).toContain('model_reasoning_effort="high"');
    expect(invocation.arguments_).toContain("--output-schema");
    expect(invocation.arguments_.at(-1)).toBe("-");
    expect(invocation.arguments_).not.toContain("danger-full-access");
    expect(invocation.arguments_).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(invocation.arguments_).not.toContain("--add-dir");
    expect(invocation.arguments_).not.toContain("--full-auto");
    expect(invocation.arguments_).toContain(
      "sandbox_workspace_write.network_access=false",
    );
    expect(invocation.arguments_).toContain(
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    );
    expect(invocation.arguments_).toContain(
      "sandbox_workspace_write.exclude_slash_tmp=true",
    );
    expect(invocation.options.shell).not.toBe(true);
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stderr: "warning\n",
      summary: { status: "completed" },
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "command",
      "file-change",
      "message",
      "usage",
    ]);
    expect(result.stdout).not.toContain("hidden-reasoning-secret");
    expect(result.stdout).not.toContain("hidden-auth-secret");
  });

  it("falls back to the supported approval-policy config override", async () => {
    const invocations: Invocation[] = [];
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(mockScript([]), invocations),
    });

    await expect(executor.inspect()).resolves.toMatchObject({
      approvalPolicyArgument: "config-override",
    });
    await executor.execute(planFor(), context());
    const arguments_ = invocations[0]!.arguments_;
    const configIndex = arguments_.indexOf("-c");

    expect(arguments_.slice(configIndex, configIndex + 2)).toEqual([
      "-c",
      'approval_policy="never"',
    ]);
    expect(arguments_).not.toContain("--ask-for-approval");
  });

  it("uses -C only when the installed Codex CLI lacks --cd", async () => {
    const invocations: Invocation[] = [];
    const executor = new CodexExecutor({
      inspectExecutable: async (_executable, arguments_) =>
        arguments_[0] === "--version" ? "codex-cli 0.test.0\n" : "-C <DIR>\n",
      spawnProcess: spawnerFor(mockScript([]), invocations),
    });

    await expect(executor.inspect()).resolves.toMatchObject({
      workingDirectoryArgument: "-C",
    });
    await executor.execute(planFor(), context());
    expect(invocations[0]!.arguments_).toContain("-C");
    expect(invocations[0]!.arguments_).not.toContain("--cd");
  });

  it("separates stderr, ignores malformed events, and rejects an invalid summary", async () => {
    const lines = [
      "not-json",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "{}" },
      }),
    ];
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(
        mockScript(lines, "OPENAI_API_KEY=sk-123456789abcdef\n", 7),
        [],
      ),
    });

    const result = await executor.execute(planFor(), context());

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain("sk-123456789abcdef");
    expect(result.summary).toBeUndefined();
    expect(result.events).toHaveLength(1);
  });

  it("terminates the detached process group on timeout", async () => {
    const script = `
process.stdin.resume();
process.stdin.on("end", () => setInterval(() => undefined, 1000));
`;
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(script, []),
      terminationGraceMs: 10,
    });

    const result = await executor.execute(planFor(), context(25));

    expect(result.timedOut).toBe(true);
  });

  it("force-kills descendants after the Codex leader exits on timeout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "braid-timeout-test-"));
    const marker = path.join(directory, "descendant-survived");
    const descendant = `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => undefined);
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "unsafe"), 250);
setInterval(() => undefined, 1000);
`;
    const script = `
const { spawn } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
  child.unref();
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => undefined, 1000);
});
`;
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(script, []),
      terminationGraceMs: 25,
    });
    try {
      const result = await executor.execute(planFor(), context(25));
      expect(result.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills background descendants after a successful Codex leader exits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "braid-close-test-"));
    const marker = path.join(directory, "descendant-survived");
    const descendant = `
const { writeFileSync } = require("node:fs");
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "unsafe"), 250);
setInterval(() => undefined, 1000);
`;
    const script = `
const { spawn } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
  child.unref();
});
`;
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(script, []),
    });
    try {
      const result = await executor.execute(planFor(), context());
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes its temporary output schema after execution", async () => {
    const invocations: Invocation[] = [];
    const executor = new CodexExecutor({
      inspectExecutable: inspectorFor(false),
      spawnProcess: spawnerFor(mockScript([]), invocations),
    });

    await executor.execute(planFor(), context());
    const arguments_ = invocations[0]!.arguments_;
    const schemaPath = arguments_[arguments_.indexOf("--output-schema") + 1]!;

    await expect(access(schemaPath)).rejects.toThrow();
  });
});

describe("ScriptedTestExecutor", () => {
  it("runs only the injected deterministic callback through the shared interface", async () => {
    const executeScript = vi.fn(() => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      events: [],
    }));
    const executor = new ScriptedTestExecutor(executeScript);
    const plan = planFor("scripted-test");

    await expect(executor.inspect()).resolves.toEqual({
      kind: "scripted-test",
      sandbox: "workspace-write",
    });
    await expect(executor.execute(plan, context())).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledWith(plan, context());
  });

  it("cannot run a production codex plan", async () => {
    const executor = new ScriptedTestExecutor(() => ({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      events: [],
    }));

    await expect(executor.execute(planFor(), context())).rejects.toThrow(
      "requires a scripted-test execution plan",
    );
  });
});
