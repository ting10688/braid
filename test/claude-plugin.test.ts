import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(repository, "plugins", "braid-claude");

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

const listTree = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    files.push(file);
    if (entry.isDirectory()) files.push(...(await listTree(file)));
  }
  return files;
};

describe("Claude native plugin package", () => {
  it("keeps marketplace and plugin metadata aligned with Braid v0.6", async () => {
    const packageJson = await readJson(path.join(repository, "package.json"));
    const marketplace = await readJson(
      path.join(repository, ".claude-plugin", "marketplace.json"),
    );
    const manifest = await readJson(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    );
    expect(marketplace.name).toBe("braid");
    expect(marketplace.version).toBe(packageJson.version);
    expect(manifest.name).toBe("braid");
    expect(manifest.version).toBe(packageJson.version);
    // Claude auto-loads hooks/hooks.json; declaring it again duplicates every hook.
    expect(manifest.hooks).toBeUndefined();
    expect(marketplace.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "braid",
          source: "./plugins/braid-claude",
          version: packageJson.version,
        }),
      ]),
    );
  });

  it("declares exactly four Claude events through the shared runtime", async () => {
    const document = await readJson(
      path.join(pluginRoot, "hooks", "hooks.json"),
    );
    const hooks = document.hooks as Record<
      string,
      Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual(
      ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].sort(),
    );
    expect(hooks.PostToolUse?.[0]?.matcher).toBe(
      "Write|Edit|MultiEdit|NotebookEdit",
    );
    for (const [event, groups] of Object.entries(hooks)) {
      const handler = groups[0]?.hooks[0];
      expect(handler).toMatchObject({ type: "command", timeout: 35 });
      expect(handler?.command).toBe(
        `node "\${CLAUDE_PLUGIN_ROOT}/runtime.mjs" claude ${event}`,
      );
    }
  });

  it("packages four Claude commands and contains no symlinks", async () => {
    for (const command of ["setup", "status", "check", "help"]) {
      const content = await readFile(
        path.join(pluginRoot, "commands", `${command}.md`),
        "utf8",
      );
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain("description:");
    }
    for (const file of await listTree(pluginRoot)) {
      expect((await lstat(file)).isSymbolicLink()).toBe(false);
    }
  });
});
