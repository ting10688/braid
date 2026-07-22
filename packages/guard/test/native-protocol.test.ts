import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GrowthModeReport } from "@braid/core";
import { describe, expect, it, vi } from "vitest";

import type {
  GrowthGuardFactory,
  GrowthGuardLifecycle,
} from "../src/contracts.js";
import {
  copilotHookInputSchemas,
  geminiHookInputSchema,
  handleNativeHook,
  type NativeAgentHost,
  type NativeHookEvent,
} from "../src/native/protocol.js";
import { codexHookInputSchema } from "../src/codex/protocol.js";
import { claudeHookInputSchema } from "../src/claude/protocol.js";
import { installCodexHooks } from "../src/codex/installer.js";

interface FixtureEvent {
  officialEventName: NativeHookEvent;
  payload: unknown;
}

interface NativeFixture {
  platform: NativeAgentHost;
  evidence: string;
  events: FixtureEvent[];
}

const report = {} as GrowthModeReport;

const createLifecycle = (
  overrides: Partial<GrowthGuardLifecycle> = {},
): GrowthGuardLifecycle => ({
  context: vi.fn(async () => ({
    report,
    text: "Braid baseline context",
    initialized: true,
  })),
  check: vi.fn(async () => ({ report, feedback: "Architecture changed" })),
  final: vi.fn(async () => ({
    report,
    feedback: "Repair the architecture regression",
    shouldBlock: true,
    unresolvedCompletion: false,
    stopAttemptsForFingerprint: 1,
  })),
  status: vi.fn(async () => ({
    enabled: true,
    sessionId: "<session-id>",
    baselineExists: true,
    baseline: null,
    current: null,
    latestReport: null,
    unresolvedCompletion: false,
  })),
  reset: vi.fn(async () => true),
  ...overrides,
});

const loadFixture = async (name: string): Promise<NativeFixture> =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/native/${name}`, import.meta.url),
      "utf8",
    ),
  ) as NativeFixture;

const optionsFor = (lifecycle: GrowthGuardLifecycle) => ({
  growthGuardFactory: vi.fn(() => lifecycle) as GrowthGuardFactory,
  resolveProjectRoot: vi.fn(async () => "/repo"),
  diagnostics: vi.fn(),
});

describe("native host hook translation", () => {
  it("validates every deterministic host fixture and retains live provenance", async () => {
    const fixtures = await Promise.all([
      loadFixture("codex-0.144.5.json"),
      loadFixture("claude-2.1.215.json"),
      loadFixture("gemini-0.40.0.json"),
      loadFixture("copilot-1.0.71.json"),
    ]);

    expect(
      fixtures.find(({ platform }) => platform === "copilot")?.evidence,
    ).toBe("sanitized-live-capture");
    for (const fixture of fixtures) {
      for (const event of fixture.events) {
        const valid =
          fixture.platform === "codex"
            ? codexHookInputSchema.safeParse(event.payload).success
            : fixture.platform === "claude"
              ? claudeHookInputSchema.safeParse(event.payload).success
              : fixture.platform === "gemini"
                ? geminiHookInputSchema.safeParse(event.payload).success
                : copilotHookInputSchemas[
                    event.officialEventName as keyof typeof copilotHookInputSchemas
                  ].safeParse(event.payload).success;
        expect(valid, `${fixture.platform}:${event.officialEventName}`).toBe(
          true,
        );
      }
    }
  });

  it.each([
    ["codex", "codex-0.144.5.json"],
    ["gemini", "gemini-0.40.0.json"],
    ["copilot", "copilot-1.0.71.json"],
  ] as const)("translates all %s lifecycle events", async (host, name) => {
    const fixture = await loadFixture(name);
    const lifecycle = createLifecycle();
    const outputs = [];
    for (const event of fixture.events) {
      outputs.push(
        await handleNativeHook(
          host,
          event.officialEventName,
          event.payload,
          optionsFor(lifecycle),
        ),
      );
    }

    if (host === "codex") {
      expect(outputs).toEqual([
        {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "Braid baseline context",
          },
        },
        {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "Braid baseline context",
          },
        },
        {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: "Architecture changed",
          },
        },
        { decision: "block", reason: "Repair the architecture regression" },
      ]);
    } else if (host === "gemini") {
      expect(outputs).toEqual([
        {
          hookSpecificOutput: { additionalContext: "Braid baseline context" },
        },
        {
          hookSpecificOutput: { additionalContext: "Braid baseline context" },
        },
        { hookSpecificOutput: { additionalContext: "Architecture changed" } },
        { decision: "deny", reason: "Repair the architecture regression" },
      ]);
    } else {
      expect(outputs).toEqual([
        { additionalContext: "Braid baseline context" },
        {},
        { additionalContext: "Architecture changed" },
        { decision: "block", reason: "Repair the architecture regression" },
      ]);
    }
  });

  it("routes the verified Claude lifecycle through the native host boundary", async () => {
    const lifecycle = createLifecycle();
    const coordinator = {
      preflight: vi.fn(async () => ({ action: "evaluate" as const })),
      claim: vi.fn(async () => true),
    };
    const common = {
      session_id: "<session-id>",
      cwd: "/repo",
      permission_mode: "default",
    };
    const events = [
      {
        name: "SessionStart" as const,
        payload: {
          session_id: common.session_id,
          cwd: common.cwd,
          hook_event_name: "SessionStart",
          source: "startup",
        },
      },
      {
        name: "UserPromptSubmit" as const,
        payload: { ...common, hook_event_name: "UserPromptSubmit" },
      },
      {
        name: "PostToolUse" as const,
        payload: {
          ...common,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_use_id: "<tool-use-id>",
        },
      },
      {
        name: "Stop" as const,
        payload: {
          ...common,
          hook_event_name: "Stop",
          stop_hook_active: false,
        },
      },
    ];
    const outputs = [];
    for (const event of events) {
      outputs.push(
        await handleNativeHook("claude", event.name, event.payload, {
          ...optionsFor(lifecycle),
          claudeDuplicateCoordinator: coordinator,
        }),
      );
    }
    expect(outputs).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "Braid Growth Mode active — architecture baseline captured.",
        },
      },
      {},
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "Architecture changed",
        },
      },
      { decision: "block", reason: "Repair the architecture regression" },
    ]);
  });

  it("allows a repaired final scan and a bounded unchanged retry", async () => {
    const fixture = await loadFixture("copilot-1.0.71.json");
    const stop = fixture.events.find(
      ({ officialEventName }) => officialEventName === "agentStop",
    );
    expect(stop).toBeDefined();

    const repaired = createLifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: null,
        shouldBlock: false,
        unresolvedCompletion: false,
        stopAttemptsForFingerprint: 0,
      })),
    });
    const repeated = createLifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: "Regression unchanged",
        shouldBlock: false,
        unresolvedCompletion: true,
        stopAttemptsForFingerprint: 2,
      })),
    });

    expect(
      await handleNativeHook(
        "copilot",
        "agentStop",
        stop?.payload,
        optionsFor(repaired),
      ),
    ).toEqual({ decision: "allow" });
    expect(
      await handleNativeHook(
        "gemini",
        "AfterAgent",
        (await loadFixture("gemini-0.40.0.json")).events.at(-1)?.payload,
        optionsFor(repeated),
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("fails open without exposing malformed payloads", async () => {
    const diagnostics = vi.fn();
    expect(
      await handleNativeHook(
        "copilot",
        "agentStop",
        { prompt: "secret" },
        {
          diagnostics,
        },
      ),
    ).toEqual({ decision: "allow" });
    expect(
      await handleNativeHook(
        "gemini",
        "AfterAgent",
        { prompt: "secret" },
        {
          diagnostics,
        },
      ),
    ).toEqual({});
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret");
  });

  it("fails the native Codex adapter open when the legacy adapter is also installed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-native-duplicate-"));
    try {
      await mkdir(path.join(root, ".git"));
      await mkdir(path.join(root, ".braid"));
      await writeFile(
        path.join(root, ".braid", "architecture.yaml"),
        "version: 1\n",
      );
      await installCodexHooks({
        projectRoot: root,
        launcher: ["node", "braid.js", "growth", "hook"],
        confirm: true,
        runCommand: async (_command, arguments_) =>
          arguments_[0] === "--version"
            ? { stdout: "codex-cli 0.144.5\n" }
            : { stdout: "hooks stable true\n" },
      });
      const fixture = await loadFixture("codex-0.144.5.json");
      const diagnostics = vi.fn();
      const result = await handleNativeHook(
        "codex",
        "SessionStart",
        fixture.events[0]?.payload,
        {
          nativePlugin: true,
          diagnostics,
          resolveProjectRoot: vi.fn(async () => root),
        },
      );

      expect(result).toMatchObject({ continue: true });
      expect(diagnostics).toHaveBeenCalledWith(
        expect.stringContaining("braid growth uninstall codex"),
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
