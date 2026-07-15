import path from "node:path";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { validationCommandSchema, type ValidationCommand } from "@braid/core";
import {
  assertSafeValidationCommand,
  runValidationCommands,
} from "../src/validation-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-validation-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts", "pass.mjs"),
    "console.log('ok');\n",
  );
  await writeFile(
    path.join(root, "scripts", "fail.mjs"),
    "console.error('failed'); process.exit(2);\n",
  );
  await writeFile(
    path.join(root, "scripts", "sleep.mjs"),
    "setTimeout(() => {}, 5000);\n",
  );
  await writeFile(
    path.join(root, "scripts", "output.mjs"),
    "process.stdout.write('x'.repeat(2048)); process.stderr.write('y'.repeat(2048));\n",
  );
  await writeFile(
    path.join(root, "scripts", "descendant.mjs"),
    "import { writeFile } from 'node:fs/promises';\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => void writeFile(process.argv[2], 'survived\\n'), 2500);\nsetInterval(() => {}, 1000);\n",
  );
  await writeFile(
    path.join(root, "scripts", "leader.mjs"),
    "import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, ['scripts/descendant.mjs', process.argv[2]], { stdio: 'ignore' });\nchild.unref();\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n",
  );
  return root;
};

const command = (
  overrides: Partial<ValidationCommand> = {},
): ValidationCommand =>
  validationCommandSchema.parse({
    id: "check",
    stage: "custom-safe-check",
    executable: "node",
    arguments: ["scripts/pass.mjs"],
    timeoutMs: 5_000,
    required: true,
    stdoutLimit: 65_536,
    stderrLimit: 65_536,
    ...overrides,
  });

describe("validation runner", () => {
  it("runs trusted executable-and-argument commands without a shell", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({ id: "typecheck", stage: "typecheck" }),
        command({ id: "test", stage: "unit-test" }),
      ],
    });
    expect(summary.passed).toBe(true);
    expect(summary.results).toHaveLength(2);
    expect(summary.results.every(({ status }) => status === "passed")).toBe(
      true,
    );
    expect(summary.results[0]?.stdout).toBe("ok\n");
  });

  it("fails the summary when a required command fails", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [command({ arguments: ["scripts/fail.mjs"] })],
    });
    expect(summary.passed).toBe(false);
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      required: true,
      exitCode: 2,
      stderr: "failed\n",
    });
  });

  it("records an optional failure as a warning and continues", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({
          id: "optional",
          arguments: ["scripts/fail.mjs"],
          required: false,
        }),
        command({ id: "required" }),
      ],
    });
    expect(summary.passed).toBe(true);
    expect(summary.results.map(({ status }) => status)).toEqual([
      "warning",
      "passed",
    ]);
  });

  it("times out a required process and safely terminates its process group", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({ arguments: ["scripts/sleep.mjs"], timeoutMs: 1_000 }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.results[0]).toMatchObject({
      status: "timeout",
      required: true,
    });
  });

  it("blocks success after an optional timeout because cleanup is uncertain", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({
          arguments: ["scripts/sleep.mjs"],
          timeoutMs: 1_000,
          required: false,
        }),
      ],
    });
    expect(summary.passed).toBe(false);
    expect(summary.results[0]).toMatchObject({
      status: "timeout",
      required: false,
    });
  });

  it("force-kills descendants after a timed-out validation leader exits", async () => {
    const root = await fixture();
    const marker = path.join(root, "descendant-survived");
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({
          arguments: ["scripts/leader.mjs", marker],
          timeoutMs: 1_000,
        }),
      ],
    });
    expect(summary.results[0]?.status).toBe("timeout");
    await delay(1_000);
    await expect(access(marker)).rejects.toThrow();
  });

  it("truncates stdout and stderr independently while draining the process", async () => {
    const root = await fixture();
    const summary = await runValidationCommands({
      worktreeRoot: root,
      commands: [
        command({
          arguments: ["scripts/output.mjs"],
          stdoutLimit: 1_024,
          stderrLimit: 1_024,
        }),
      ],
    });
    expect(summary.results[0]).toMatchObject({
      status: "passed",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(Buffer.byteLength(summary.results[0]!.stdout)).toBe(1_024);
    expect(Buffer.byteLength(summary.results[0]!.stderr)).toBe(1_024);
  });

  it("rejects shells, direct Git/network tools, inline evaluation, and dependency installation", () => {
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "git", arguments: ["push", "origin"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "sh", arguments: ["-c", "echo unsafe"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "env", arguments: ["git", "push"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "setsid", arguments: ["node", "unsafe.mjs"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "node", arguments: ["--eval", "unsafe()"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "node", arguments: ["--eval=unsafe()"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "nodejs", arguments: ["-eunsafe()"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsafe-validation-command" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "pnpm", arguments: ["exec", "git", "push"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "dependency-install-forbidden" }),
    );
    expect(() =>
      assertSafeValidationCommand(
        command({ executable: "pnpm", arguments: ["install"] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "dependency-install-forbidden" }),
    );
  });

  it("confines command working directories to the real worktree", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "braid-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(root, "escape"));
    await expect(
      runValidationCommands({
        worktreeRoot: root,
        commands: [command({ workingDirectory: "escape" })],
      }),
    ).rejects.toMatchObject({ code: "validation-cwd-escape", exitCode: 9 });
  });
});
