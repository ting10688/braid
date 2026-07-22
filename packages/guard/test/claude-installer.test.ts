import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "../src/codex/capabilities.js";
import {
  BRAID_CLAUDE_HOOK_STATUS,
  createClaudeHookCommand,
  inspectClaudeHookInstallation,
  installClaudeHooks,
  uninstallClaudeHooks,
} from "../src/claude/installer.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const git = async (root: string, ...arguments_: string[]): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
    })
  ).stdout.trim();

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-claude-hooks-"));
  roots.push(root);
  await git(root, "init", "-q");
  await mkdir(path.join(root, ".braid"));
  await writeFile(
    path.join(root, ".braid", "architecture.yaml"),
    "version: 1\n",
  );
  await git(root, "config", "user.name", "Claude Installer Test");
  await git(root, "config", "user.email", "claude@example.invalid");
  await git(root, "add", ".braid/architecture.yaml");
  await git(root, "commit", "-qm", "fixture");
  return root;
};

const supportedRunner: CommandRunner = vi.fn(async () => ({
  stdout: "2.1.215 (Claude Code)\n",
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository-local Claude hook installation", () => {
  it("requires confirmation and exposes a write-free dry-run diff", async () => {
    const root = await createProject();
    await expect(
      installClaudeHooks({
        projectRoot: root,
        launcher: ["braid", "growth", "hook"],
        runCommand: supportedRunner,
      }),
    ).rejects.toThrow("explicit confirmation");

    const result = await installClaudeHooks({
      projectRoot: root,
      launcher: ["braid", "growth", "hook"],
      runCommand: supportedRunner,
      dryRun: true,
    });
    expect(result).toMatchObject({
      dryRun: true,
      changed: true,
      installed: true,
      ownedHandlerCount: 4,
    });
    expect(result.diff).toContain('"SessionStart"');
    await expect(readFile(result.configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("merges unrelated settings, backs up once, and is idempotent", async () => {
    const root = await createProject();
    const directory = path.join(root, ".claude");
    const configPath = path.join(directory, "settings.local.json");
    await mkdir(directory);
    const original = `${JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "./existing" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(configPath, original);

    const first = await installClaudeHooks({
      projectRoot: root,
      launcher: ["/path with spaces/braid", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    expect(first).toMatchObject({
      changed: true,
      installed: true,
      ownedHandlerCount: 4,
    });
    expect(await readFile(first.backupPath ?? "", "utf8")).toBe(original);
    const document = JSON.parse(await readFile(configPath, "utf8")) as {
      permissions: unknown;
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };
    expect(document.permissions).toEqual({ allow: ["Read"] });
    expect(JSON.stringify(document.hooks.Stop)).toContain("./existing");
    expect(document.hooks.PostToolUse?.at(-1)?.matcher).toBe(
      "Write|Edit|MultiEdit|NotebookEdit",
    );
    expect(JSON.stringify(document)).toContain(BRAID_CLAUDE_HOOK_STATUS);
    expect(JSON.stringify(document)).toContain("--source");
    expect(JSON.stringify(document)).toContain("manual");

    const second = await installClaudeHooks({
      projectRoot: root,
      launcher: ["/path with spaces/braid", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
  });

  it("uninstalls only owned handlers and preserves unrelated settings", async () => {
    const root = await createProject();
    await installClaudeHooks({
      projectRoot: root,
      launcher: ["braid", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    const configPath = path.join(root, ".claude", "settings.local.json");
    const document = JSON.parse(await readFile(configPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    document.theme = "dark";
    await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const dryRun = await uninstallClaudeHooks({
      projectRoot: root,
      dryRun: true,
    });
    expect(dryRun.removedHandlerCount).toBe(4);
    expect((await inspectClaudeHookInstallation(root)).installed).toBe(true);

    const removed = await uninstallClaudeHooks({ projectRoot: root });
    expect(removed).toMatchObject({
      changed: true,
      installed: false,
      removedHandlerCount: 4,
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      theme: "dark",
    });
    expect(await uninstallClaudeHooks({ projectRoot: root })).toMatchObject({
      changed: false,
      removedHandlerCount: 0,
    });
  });

  it("refuses malformed settings, ambiguous ownership, and symlink targets", async () => {
    const root = await createProject();
    const directory = path.join(root, ".claude");
    const configPath = path.join(directory, "settings.local.json");
    await mkdir(directory);
    await writeFile(configPath, "{ malformed");
    await expect(
      installClaudeHooks({
        projectRoot: root,
        launcher: ["braid"],
        runCommand: supportedRunner,
        dryRun: true,
      }),
    ).rejects.toThrow();

    await writeFile(
      configPath,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "BRAID_GROWTH_HOOK_OWNER='unexpected' braid" }] }] } })}\n`,
    );
    await expect(uninstallClaudeHooks({ projectRoot: root })).rejects.toThrow(
      "ambiguous",
    );

    await rm(configPath);
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{}\n");
    await symlink(outside, configPath);
    await expect(inspectClaudeHookInstallation(root)).rejects.toThrow(
      "symbolic link",
    );
  });

  it("uses the main checkout settings file from a linked worktree", async () => {
    const root = await createProject();
    const worktree = `${root}-linked`;
    roots.push(worktree);
    await git(root, "worktree", "add", "-q", "-b", "linked-test", worktree);

    const result = await installClaudeHooks({
      projectRoot: worktree,
      launcher: ["braid", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    expect(result.configPath).toBe(
      path.join(await realpath(root), ".claude", "settings.local.json"),
    );
    await expect(
      lstat(path.join(worktree, ".claude", "settings.local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the original and cleans temporary state on atomic write failure", async () => {
    const root = await createProject();
    const directory = path.join(root, ".claude");
    const configPath = path.join(directory, "settings.local.json");
    await mkdir(directory);
    const original = '{"theme":"dark"}\n';
    await writeFile(configPath, original);

    await expect(
      installClaudeHooks({
        projectRoot: root,
        launcher: ["braid"],
        runCommand: supportedRunner,
        confirm: true,
        renameFile: async () => {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toThrow("injected rename failure");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(
      (await readdir(directory)).some((file) => file.includes("braid-tmp")),
    ).toBe(false);
  });

  it("does not write when Claude is outside the exact verified version", async () => {
    const root = await createProject();
    await expect(
      installClaudeHooks({
        projectRoot: root,
        launcher: ["braid"],
        runCommand: async () => ({ stdout: "2.1.216" }),
        confirm: true,
      }),
    ).rejects.toThrow("not supported");
    expect((await inspectClaudeHookInstallation(root)).exists).toBe(false);
  });

  it("quotes launcher arguments without expanding shell content", () => {
    expect(() => createClaudeHookCommand(["braid", ""])).toThrow();
    const command = createClaudeHookCommand(["a path", "$HOME", "a'b"]);
    expect(command).toContain("'a path'");
    expect(command).toContain("'$HOME'");
    expect(command).toContain(`'a'"'"'b'`);
  });
});
