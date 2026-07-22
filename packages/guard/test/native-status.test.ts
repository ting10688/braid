import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { probeNativeAgent } from "../src/native/status.js";

const temporaryRoots: string[] = [];
const originalGeminiHome = process.env.GEMINI_CLI_HOME;

afterEach(async () => {
  if (originalGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = originalGeminiHome;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("native agent status probes", () => {
  it("accepts only the authenticated Claude Code contract and detects the plugin", async () => {
    const installed = await probeNativeAgent("claude", {
      runCommand: async (_command, arguments_) =>
        arguments_[0] === "--version"
          ? { stdout: "2.1.215 (Claude Code)\n" }
          : {
              stdout:
                '[{"id":"braid@braid","version":"0.6.0","enabled":true}]\n',
            },
    });
    expect(installed).toMatchObject({
      supported: true,
      adapterDiscovered: true,
      version: "2.1.215",
      classification: "verified",
    });

    const future = await probeNativeAgent("claude", {
      runCommand: async () => ({ stdout: "2.1.216 (Claude Code)\n" }),
    });
    expect(future).toMatchObject({ supported: false, version: "2.1.216" });
  });

  it("parses installed Copilot CLI output and rejects an unverified version", async () => {
    const installed = await probeNativeAgent("copilot", {
      runCommand: async (_command, arguments_) =>
        arguments_[0] === "--version"
          ? { stdout: "GitHub Copilot CLI 1.0.71\n" }
          : { stdout: "Installed plugins:\n  • braid@braid (v0.6.0)\n" },
    });
    expect(installed).toMatchObject({
      supported: true,
      adapterDiscovered: true,
      classification: "verified-with-limitations",
    });

    const future = await probeNativeAgent("copilot", {
      runCommand: async () => ({ stdout: "GitHub Copilot CLI 1.1.0\n" }),
    });
    expect(future).toMatchObject({ supported: false, version: "1.1.0" });
  });

  it("uses Gemini's installed manifest and workspace enablement when list is empty without a TTY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-gemini-status-"));
    temporaryRoots.push(root);
    process.env.GEMINI_CLI_HOME = root;
    const extensions = path.join(root, ".gemini", "extensions");
    const plugin = path.join(extensions, "braid");
    const workspace = path.join(root, "workspace");
    await mkdir(plugin, { recursive: true });
    await mkdir(workspace);
    await writeFile(
      path.join(plugin, "gemini-extension.json"),
      '{"name":"braid","version":"0.6.0"}\n',
    );
    const runCommand = async (_command: string, arguments_: string[]) =>
      arguments_[0] === "--version" ? { stdout: "0.40.0\n" } : { stdout: "" };

    expect(
      await probeNativeAgent("gemini", {
        runCommand,
        workspacePath: workspace,
      }),
    ).toMatchObject({ supported: true, adapterDiscovered: true });

    await writeFile(
      path.join(extensions, "extension-enablement.json"),
      `${JSON.stringify({ braid: { overrides: [`!${workspace}/*`] } })}\n`,
    );
    expect(
      await probeNativeAgent("gemini", {
        runCommand,
        workspacePath: workspace,
      }),
    ).toMatchObject({ supported: true, adapterDiscovered: false });
  });
});
