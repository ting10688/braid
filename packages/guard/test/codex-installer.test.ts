import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeCodexHookCapabilities,
  type CommandRunner,
} from "../src/codex/capabilities.js";
import {
  BRAID_CODEX_HOOK_STATUS,
  createCodexHookCommand,
  inspectCodexHookInstallation,
  installCodexHooks,
  uninstallCodexHooks,
} from "../src/codex/installer.js";

const roots: string[] = [];

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-codex-hooks-"));
  roots.push(root);
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".braid"));
  await writeFile(
    path.join(root, ".braid", "architecture.yaml"),
    "version: 1\n",
  );
  return root;
};

const supportedRunner: CommandRunner = vi.fn(async (_command, arguments_) => {
  if (arguments_[0] === "--version") {
    return { stdout: "codex-cli 0.144.2\n" };
  }
  return { stdout: "hooks                    stable             true\n" };
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
  vi.restoreAllMocks();
});

describe("Codex hook capability probe", () => {
  it("supports the verified 0.144.x contract with hooks enabled", async () => {
    const result = await probeCodexHookCapabilities({
      codexExecutable: "/Applications/Codex",
      runCommand: supportedRunner,
    });

    expect(result).toMatchObject({
      version: "0.144.2",
      hookFeature: { stage: "stable", enabled: true },
      supported: true,
      repositoryConfigPath: ".codex/hooks.json",
      timeoutSeconds: 30,
    });
    expect(result.supportedEvents).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]);
    expect(result.capabilities.stopBlocking).toBe(true);
    expect(result.capabilities.requiresTrust).toBe(true);
  });

  it("does not claim support when hooks are off, probing fails, or version is unverified", async () => {
    const disabled = await probeCodexHookCapabilities({
      runCommand: async (_command, arguments_) =>
        arguments_[0] === "--version"
          ? { stdout: "codex-cli 0.144.2" }
          : { stdout: "hooks stable false" },
    });
    expect(disabled.supported).toBe(false);
    expect(disabled.reason).toContain("disabled");

    const future = await probeCodexHookCapabilities({
      runCommand: async (_command, arguments_) =>
        arguments_[0] === "--version"
          ? { stdout: "codex-cli 0.145.0" }
          : { stdout: "hooks stable true" },
    });
    expect(future.supported).toBe(false);
    expect(future.reason).toContain("outside the verified");
    expect(future.hookFeature.enabled).toBe(true);

    const experimental = await probeCodexHookCapabilities({
      runCommand: async (_command, arguments_) =>
        arguments_[0] === "--version"
          ? { stdout: "codex-cli 0.144.2" }
          : { stdout: "hooks experimental true" },
    });
    expect(experimental.supported).toBe(false);
    expect(experimental.reason).toContain("verified stable");

    const failed = await probeCodexHookCapabilities({
      runCommand: async () => {
        throw new Error("missing executable");
      },
    });
    expect(failed.supported).toBe(false);
    expect(failed.reason).toContain("probe failed");
  });
});

describe("repo-local Codex hook installation", () => {
  it("requires confirmation and keeps dry-run free of writes", async () => {
    const root = await createProject();
    const configPath = path.join(root, ".codex", "hooks.json");

    await expect(
      installCodexHooks({
        projectRoot: root,
        launcher: ["node", "braid.js", "growth", "hook"],
        runCommand: supportedRunner,
      }),
    ).rejects.toThrow("explicit confirmation");
    expect((await inspectCodexHookInstallation(root)).exists).toBe(false);

    const dryRun = await installCodexHooks({
      projectRoot: root,
      launcher: ["node", "braid.js", "growth", "hook"],
      runCommand: supportedRunner,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      changed: true,
      dryRun: true,
      installed: true,
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("merges unrelated hooks, backs up once, and is idempotent", async () => {
    const root = await createProject();
    const codexDirectory = path.join(root, ".codex");
    const configPath = path.join(codexDirectory, "hooks.json");
    await mkdir(codexDirectory);
    const original = `${JSON.stringify(
      {
        $schema: "https://example.invalid/hooks.schema.json",
        custom: { preserved: true },
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "./existing-hook",
                  statusMessage: "Existing",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(configPath, original);

    const first = await installCodexHooks({
      projectRoot: root,
      launcher: ["/path with spaces/node", "braid's cli.js", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    expect(first).toMatchObject({
      changed: true,
      installed: true,
      ownedHandlerCount: 4,
    });
    expect(first.backupPath).not.toBeNull();
    expect(await readFile(first.backupPath ?? "", "utf8")).toBe(original);

    const installed = JSON.parse(await readFile(configPath, "utf8")) as {
      custom: unknown;
      hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    };
    expect(installed.custom).toEqual({ preserved: true });
    expect(installed.hooks.PostToolUse?.[0]?.matcher).toBe("Bash");
    expect(JSON.stringify(installed.hooks.PostToolUse?.[0]?.hooks)).toContain(
      "./existing-hook",
    );
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]) {
      const ownedGroup = installed.hooks[event]?.at(-1);
      expect(ownedGroup).not.toHaveProperty("matcher");
      expect(JSON.stringify(ownedGroup)).toContain(BRAID_CODEX_HOOK_STATUS);
      const handler = ownedGroup?.hooks[0] as { command: string };
      expect(handler.command).toContain(`'braid'"'"'s cli.js'`);
    }

    const second = await installCodexHooks({
      projectRoot: root,
      launcher: ["/path with spaces/node", "braid's cli.js", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    const backupFiles = (await readdir(codexDirectory)).filter((file) =>
      file.includes(".braid-backup-"),
    );
    expect(backupFiles).toHaveLength(1);
    expect((await inspectCodexHookInstallation(root)).ownedHandlerCount).toBe(
      4,
    );
  });

  it("quotes every launcher argument for a POSIX shell", () => {
    expect(() =>
      createCodexHookCommand(["node path", "a'b", "$HOME", ""]),
    ).toThrow("non-empty");
    const command = createCodexHookCommand(["node path", "a'b", "$HOME"]);
    expect(command).toContain("'node path'");
    expect(command).toContain(`'a'"'"'b'`);
    expect(command).toContain("'$HOME'");
  });

  it("uninstalls only owned handlers, including from a mixed group", async () => {
    const root = await createProject();
    await installCodexHooks({
      projectRoot: root,
      launcher: ["node", "braid.js", "growth", "hook"],
      runCommand: supportedRunner,
      confirm: true,
    });
    const configPath = path.join(root, ".codex", "hooks.json");
    const document = JSON.parse(await readFile(configPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    const sessionOwned = document.hooks.SessionStart?.[0]?.hooks[0];
    document.hooks.SessionStart = [
      {
        hooks: [
          sessionOwned,
          {
            type: "command",
            command: "./keep-me",
            statusMessage: "Unrelated",
          },
          {
            type: "command",
            command: "./similar-but-unowned",
            statusMessage: BRAID_CODEX_HOOK_STATUS,
          },
        ],
      },
    ];
    await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`);
    const beforeDryRun = await readFile(configPath, "utf8");

    const dryRun = await uninstallCodexHooks({
      projectRoot: root,
      dryRun: true,
    });
    expect(dryRun.removedHandlerCount).toBe(4);
    expect(await readFile(configPath, "utf8")).toBe(beforeDryRun);

    const removed = await uninstallCodexHooks({ projectRoot: root });
    expect(removed).toMatchObject({
      changed: true,
      installed: false,
      ownedHandlerCount: 0,
      removedHandlerCount: 4,
    });
    const remaining = await readFile(configPath, "utf8");
    expect(remaining).toContain("./keep-me");
    expect(remaining).toContain("./similar-but-unowned");
    expect(remaining).not.toContain("BRAID_GROWTH_HOOK_OWNER");

    const again = await uninstallCodexHooks({ projectRoot: root });
    expect(again).toMatchObject({
      changed: false,
      removedHandlerCount: 0,
    });
  });
});
