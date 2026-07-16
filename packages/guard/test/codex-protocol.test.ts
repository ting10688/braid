import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import type { GrowthModeReport } from "@braid/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GrowthGuardFactory,
  GrowthGuardLifecycle,
} from "../src/contracts.js";
import {
  codexHookInputSchema,
  codexHookOutputSchema,
  handleCodexHook,
  resolveCodexProjectRoot,
  runCodexHookStdio,
} from "../src/codex/protocol.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const report = {} as GrowthModeReport;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const createLifecycle = (
  overrides: Partial<GrowthGuardLifecycle> = {},
): GrowthGuardLifecycle => ({
  context: vi.fn(async () => ({
    report,
    text: "Baseline ready",
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
  transcript_path: null,
  cwd: "/repo/subdirectory",
  model: "gpt-5",
  permission_mode: "default",
};

const optionsFor = (lifecycle: GrowthGuardLifecycle) => {
  const growthGuardFactory: GrowthGuardFactory = vi.fn(() => lifecycle);
  return {
    growthGuardFactory,
    resolveProjectRoot: vi.fn(async () => "/repo"),
    diagnostics: vi.fn(),
  };
};

describe("Codex hook protocol", () => {
  it("resolves only the Git root containing Braid configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-codex-root-"));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "-q", root]);
    await mkdir(path.join(root, ".braid"));
    await writeFile(
      path.join(root, ".braid", "architecture.yaml"),
      "version: 1\n",
    );
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });

    expect(await resolveCodexProjectRoot(nested)).toBe(await realpath(root));
    await rm(path.join(root, ".braid", "architecture.yaml"));
    await expect(resolveCodexProjectRoot(nested)).rejects.toThrow();
  });

  it("validates the verified 0.144.2 event schemas", () => {
    const events = [
      {
        ...base,
        hook_event_name: "SessionStart",
        source: "startup",
      },
      {
        ...base,
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
        prompt: "continue",
      },
      {
        ...base,
        turn_id: "turn-1",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "printf ignored" },
        tool_response: { output: "ignored" },
      },
      {
        ...base,
        turn_id: "turn-1",
        hook_event_name: "Stop",
        stop_hook_active: true,
        last_assistant_message: null,
      },
    ];

    for (const event of events) {
      expect(codexHookInputSchema.safeParse(event).success).toBe(true);
    }
    expect(
      codexHookInputSchema.safeParse({
        ...base,
        turn_id: "turn-1",
        hook_event_name: "Stop",
      }).success,
    ).toBe(false);
  });

  it("adds baseline context on SessionStart and lazy UserPromptSubmit", async () => {
    const lifecycle = createLifecycle();
    const options = optionsFor(lifecycle);
    const sessionOutput = await handleCodexHook(
      { ...base, hook_event_name: "SessionStart", source: "resume" },
      options,
    );
    const promptOutput = await handleCodexHook(
      {
        ...base,
        turn_id: "turn-1",
        hook_event_name: "UserPromptSubmit",
        prompt: "work",
      },
      options,
    );

    expect(sessionOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Baseline ready",
      },
    });
    expect(promptOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Baseline ready",
      },
    });
    expect(lifecycle.context).toHaveBeenCalledTimes(2);
  });

  it("returns PostToolUse additionalContext only when feedback exists", async () => {
    const changed = createLifecycle({
      check: vi.fn(async () => ({ report, feedback: "New cycle detected" })),
    });
    const unchanged = createLifecycle();
    const input = {
      ...base,
      turn_id: "turn-1",
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_use_id: "tool-1",
      tool_input: { patch: "never parsed" },
      tool_response: {},
    };

    expect(await handleCodexHook(input, optionsFor(changed))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "New cycle detected",
      },
    });
    expect(await handleCodexHook(input, optionsFor(unchanged))).toEqual({
      continue: true,
    });
  });

  it("blocks the first Stop and visibly allows an unchanged unresolved retry", async () => {
    const stopInput = {
      ...base,
      turn_id: "turn-1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "done",
    };
    const blocking = createLifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: "Break the new cycle",
        shouldBlock: true,
        unresolvedCompletion: false,
        stopAttemptsForFingerprint: 1,
      })),
    });
    const unresolved = createLifecycle({
      final: vi.fn(async () => ({
        report,
        feedback: "Cycle remains",
        shouldBlock: false,
        unresolvedCompletion: true,
        stopAttemptsForFingerprint: 2,
      })),
    });

    expect(await handleCodexHook(stopInput, optionsFor(blocking))).toEqual({
      decision: "block",
      reason: "Break the new cycle",
    });
    const retry = await handleCodexHook(stopInput, optionsFor(unresolved));
    expect(retry).toMatchObject({ continue: true });
    expect(JSON.stringify(retry)).toContain("already blocked once");
  });

  it("fails open visibly for malformed input and analysis errors", async () => {
    const malformedDiagnostics = vi.fn();
    const malformed = await handleCodexHook(
      { hook_event_name: "Stop" },
      { diagnostics: malformedDiagnostics },
    );
    expect(malformed).toMatchObject({ continue: true });
    expect(JSON.stringify(malformed)).toContain("could not evaluate");
    expect(JSON.stringify(malformed).toLowerCase()).not.toContain('"pass"');
    expect(malformedDiagnostics).toHaveBeenCalledOnce();

    const lifecycle = createLifecycle({
      check: vi.fn(async () => {
        throw new Error("scanner unavailable");
      }),
    });
    const diagnostics = vi.fn();
    const failed = await handleCodexHook(
      {
        ...base,
        turn_id: "turn-1",
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_use_id: "tool-1",
        tool_input: {},
        tool_response: {},
      },
      {
        ...optionsFor(lifecycle),
        diagnostics,
      },
    );
    expect(failed).toMatchObject({ continue: true });
    expect(JSON.stringify(failed)).toContain("could not evaluate");
    expect(diagnostics).toHaveBeenCalledOnce();

    const emptyContext = createLifecycle({
      context: vi.fn(async () => ({ report, text: "", initialized: true })),
    });
    const empty = await handleCodexHook(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      optionsFor(emptyContext),
    );
    expect(empty).toMatchObject({ continue: true });
    expect(JSON.stringify(empty)).toContain("could not evaluate");
  });

  it("reads one stdin JSON value and writes exactly one stdout JSON value", async () => {
    const lifecycle = createLifecycle();
    const input = Readable.from([
      JSON.stringify({
        ...base,
        hook_event_name: "SessionStart",
        source: "compact",
      }),
    ]);
    let stdoutText = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });

    await runCodexHookStdio({
      ...optionsFor(lifecycle),
      stdin: input,
      stdout: output,
    });

    const lines = stdoutText.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(codexHookOutputSchema.parse(JSON.parse(lines[0] ?? ""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Baseline ready",
      },
    });
  });
});
