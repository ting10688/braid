import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_SUPPORTED_VERSION,
  inspectClaudeNativePlugin,
  probeClaudeHookCapabilities,
} from "../src/claude/capabilities.js";

describe("Claude hook capability probe", () => {
  it("supports only the authenticated 2.1.215 native-plugin contract", async () => {
    const supported = await probeClaudeHookCapabilities({
      claudeExecutable: "/Applications/Claude",
      runCommand: async () => ({ stdout: "2.1.215 (Claude Code)\n" }),
    });
    expect(supported).toMatchObject({
      provider: "claude",
      version: CLAUDE_CODE_SUPPORTED_VERSION,
      supported: true,
      repositoryConfigPath: ".claude/settings.local.json",
      timeoutSeconds: 30,
    });
    expect(supported.supportedEvents).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]);

    for (const version of ["2.1.214", "2.1.216", "unparseable"]) {
      const result = await probeClaudeHookCapabilities({
        runCommand: async () => ({ stdout: version }),
      });
      expect(result.supported).toBe(false);
      expect(result.supportedEvents).toEqual([]);
    }
  });

  it("fails closed for capability claims when the executable probe fails", async () => {
    const result = await probeClaudeHookCapabilities({
      runCommand: async () => {
        throw new Error("missing executable at /Users/private/bin");
      },
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("version probe failed");
    expect(result.reason).not.toContain("/Users/private");
  });

  it("reports only the Braid native plugin from Claude's plugin list", async () => {
    const installed = await inspectClaudeNativePlugin({
      runCommand: async () => ({
        stdout: JSON.stringify([
          { id: "unrelated@market", enabled: true, installPath: "/private" },
          { id: "braid@braid", enabled: false, installPath: "/private" },
        ]),
      }),
    });
    expect(installed).toEqual({
      id: "braid@braid",
      installed: true,
      enabled: false,
      reason: null,
    });
    expect(JSON.stringify(installed)).not.toContain("unrelated");
    expect(JSON.stringify(installed)).not.toContain("/private");
  });
});
