import { Readable, Writable } from "node:stream";

import type { GrowthModeReport } from "@braid/core";
import { describe, expect, it, vi } from "vitest";

import type {
  GrowthGuardFactory,
  GrowthGuardLifecycle,
} from "../src/contracts.js";
import {
  claudeHookInputSchema,
  claudeHookOutputSchema,
  handleClaudeHook,
  runClaudeHookStdio,
} from "../src/claude/protocol.js";

const report = { skippedReason: null } as GrowthModeReport;
const disabledReport = {
  skippedReason: "growth-mode-disabled",
} as GrowthModeReport;

const lifecycle = (
  overrides: Partial<GrowthGuardLifecycle> = {},
): GrowthGuardLifecycle => ({
  context: vi.fn(async () => ({
    report,
    text: "ignored host-neutral context",
    initialized: true,
  })),
  check: vi.fn(async () => ({ report, feedback: null })),
  final: vi.fn(async () => ({
    report,
    feedback: null,
    shouldBlock: false,
    unresolvedCompletion: false,
    stopAttemptsForFingerprint: 0,
  })),
  status: vi.fn(async () => ({
    enabled: true,
    sessionId: "session-1",
    baselineExists: true,
    baseline: null,
    current: null,
    latestReport: null,
    unresolvedCompletion: false,
  })),
  reset: vi.fn(async () => true),
  ...overrides,
});

const base = {
  session_id: "session-1",
  transcript_path: "/private/transcript.jsonl",
  cwd: "/repo",
  permission_mode: "dontAsk",
};

const options = (guard: GrowthGuardLifecycle) => {
  const growthGuardFactory: GrowthGuardFactory = vi.fn(() => guard);
  return {
    growthGuardFactory,
    resolveProjectRoot: vi.fn(async () => "/repo"),
    diagnostics: vi.fn(),
  };
};

describe("Claude hook protocol", () => {
  it("parses only the verified fields for all four lifecycle events", () => {
    const inputs = [
      {
        session_id: base.session_id,
        transcript_path: base.transcript_path,
        cwd: base.cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      },
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "private" },
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_use_id: "tool-1",
        tool_input: { file_path: "/private/file" },
        tool_response: { content: "private" },
      },
      { ...base, hook_event_name: "Stop", stop_hook_active: false },
    ];

    for (const input of inputs) {
      const parsed = claudeHookInputSchema.parse(input);
      expect(parsed).not.toHaveProperty("transcript_path");
      expect(parsed).not.toHaveProperty("prompt");
      expect(parsed).not.toHaveProperty("tool_input");
      expect(parsed).not.toHaveProperty("tool_response");
    }
  });

  it("activates once on SessionStart only when Growth Mode is enabled", async () => {
    const active = lifecycle();
    expect(
      await handleClaudeHook(
        { ...base, hook_event_name: "SessionStart", source: "startup" },
        options(active),
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Braid Growth Mode active — architecture baseline captured.",
      },
    });

    const disabled = lifecycle({
      context: vi.fn(async () => ({
        report: disabledReport,
        text: "disabled",
        initialized: true,
      })),
    });
    expect(
      await handleClaudeHook(
        { ...base, hook_event_name: "SessionStart", source: "startup" },
        options(disabled),
      ),
    ).toEqual({});
  });

  it("uses UserPromptSubmit as a silent lazy baseline fallback", async () => {
    const guard = lifecycle();
    expect(
      await handleClaudeHook(
        { ...base, hook_event_name: "UserPromptSubmit", prompt: "private" },
        options(guard),
      ),
    ).toEqual({});
    expect(guard.context).toHaveBeenCalledOnce();
  });

  it("checks only relevant mutation tools", async () => {
    const guard = lifecycle({
      check: vi.fn(async () => ({ report, feedback: "Break the new cycle" })),
    });
    const input = {
      ...base,
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-1",
      tool_input: {},
      tool_response: {},
    };

    expect(
      await handleClaudeHook({ ...input, tool_name: "Read" }, options(guard)),
    ).toEqual({});
    expect(guard.check).not.toHaveBeenCalled();
    expect(
      await handleClaudeHook({ ...input, tool_name: "Edit" }, options(guard)),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Break the new cycle",
      },
    });
  });

  it("translates Stop block, unresolved allow, and passing allow", async () => {
    const stop = { ...base, hook_event_name: "Stop", stop_hook_active: false };
    const blocking = lifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: "Repair the dependency cycle",
        shouldBlock: true,
        unresolvedCompletion: false,
        stopAttemptsForFingerprint: 1,
      })),
    });
    expect(await handleClaudeHook(stop, options(blocking))).toEqual({
      decision: "block",
      reason: "Repair the dependency cycle",
    });

    const unresolved = lifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: "Cycle remains",
        shouldBlock: false,
        unresolvedCompletion: true,
        stopAttemptsForFingerprint: 2,
      })),
    });
    expect(await handleClaudeHook(stop, options(unresolved))).toEqual({
      systemMessage:
        "Cycle remains\n\nCompletion is allowed because this unchanged regression fingerprint was already blocked.",
    });
    expect(await handleClaudeHook(stop, options(lifecycle()))).toEqual({});
  });

  it("fails open silently for malformed input and analysis errors", async () => {
    const diagnostics = vi.fn();
    expect(
      await handleClaudeHook(
        { hook_event_name: "Stop", prompt: "must not leak" },
        { diagnostics },
      ),
    ).toEqual({});
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      "must not leak",
    );

    const failed = lifecycle({
      check: vi.fn(async () => {
        throw new Error("scanner unavailable at /Users/private/project");
      }),
    });
    expect(
      await handleClaudeHook(
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_use_id: "tool-1",
          tool_input: {},
          tool_response: {},
        },
        options(failed),
      ),
    ).toEqual({});
  });

  it("writes exactly one JSON object to stdout", async () => {
    const input = Readable.from([
      JSON.stringify({
        ...base,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    ]);
    let stdout = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });

    await runClaudeHookStdio({
      ...options(lifecycle()),
      stdin: input,
      stdout: output,
    });

    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(claudeHookOutputSchema.parse(JSON.parse(lines[0] ?? ""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Braid Growth Mode active — architecture baseline captured.",
      },
    });
  });

  it("skips duplicate manual evaluation with an exact remediation", async () => {
    const guard = lifecycle();
    const result = await handleClaudeHook(
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "private" },
      {
        ...options(guard),
        source: "manual",
        duplicateCoordinator: {
          preflight: vi.fn(async () => ({ action: "duplicate" as const })),
          claim: vi.fn(async () => false),
        },
      },
    );
    expect(guard.context).not.toHaveBeenCalled();
    expect(result).toEqual({
      systemMessage:
        "Braid detected both Claude adapters. Keep the native plugin and run: braid growth uninstall claude",
    });
  });
});
