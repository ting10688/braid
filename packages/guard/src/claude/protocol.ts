import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import type { GrowthGuardFactory } from "../contracts.js";
import { createGrowthGuard } from "../growth-guard.js";
import { resolveCodexProjectRoot } from "../codex/protocol.js";
import { CLAUDE_HOOK_ADAPTER_COMPATIBILITY } from "./capabilities.js";
import {
  createClaudeDuplicateCoordinator,
  type ClaudeDuplicateCoordinator,
  type ClaudeHookSource,
} from "./duplicate-store.js";

const commonInputFields = {
  session_id: z.string().min(1),
  cwd: z.string().min(1),
};

const turnInputFields = {
  ...commonInputFields,
  permission_mode: z.string().min(1),
};

export const claudeSessionStartInputSchema = z.object({
  ...commonInputFields,
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear", "compact"]),
});

export const claudeUserPromptSubmitInputSchema = z.object({
  ...turnInputFields,
  hook_event_name: z.literal("UserPromptSubmit"),
});

export const claudePostToolUseInputSchema = z.object({
  ...turnInputFields,
  hook_event_name: z.literal("PostToolUse"),
  tool_name: z.string().min(1),
  tool_use_id: z.string().min(1),
});

export const claudeStopInputSchema = z.object({
  ...turnInputFields,
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean(),
});

export const claudeHookInputSchema = z.discriminatedUnion("hook_event_name", [
  claudeSessionStartInputSchema,
  claudeUserPromptSubmitInputSchema,
  claudePostToolUseInputSchema,
  claudeStopInputSchema,
]);

const emptyOutputSchema = z.object({}).strict();
const contextOutputSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.enum([
          "SessionStart",
          "UserPromptSubmit",
          "PostToolUse",
        ]),
        additionalContext: z.string().min(1),
      })
      .strict(),
  })
  .strict();
const stopBlockOutputSchema = z
  .object({
    decision: z.literal("block"),
    reason: z.string().min(1),
  })
  .strict();
const systemMessageOutputSchema = z
  .object({ systemMessage: z.string().min(1) })
  .strict();

export const claudeHookOutputSchema = z.union([
  emptyOutputSchema,
  contextOutputSchema,
  stopBlockOutputSchema,
  systemMessageOutputSchema,
]);

export type ClaudeHookInput = z.infer<typeof claudeHookInputSchema>;
export type ClaudeHookOutput = z.infer<typeof claudeHookOutputSchema>;
export type ClaudeHookDiagnostics = (message: string) => void;

export interface HandleClaudeHookOptions {
  growthGuardFactory?: GrowthGuardFactory;
  diagnostics?: ClaudeHookDiagnostics;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
  source?: ClaudeHookSource;
  duplicateCoordinator?: ClaudeDuplicateCoordinator;
}

export const RELEVANT_CLAUDE_MUTATION_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
] as const;

const relevantMutationTools = new Set<string>(RELEVANT_CLAUDE_MUTATION_TOOLS);
const defaultDiagnostics: ClaudeHookDiagnostics = (message) => {
  process.stderr.write(`[braid-growth] ${message}\n`);
};

export const CLAUDE_DUPLICATE_REMEDIATION =
  "Braid detected both Claude adapters. Keep the native plugin and run: braid growth uninstall claude" as const;

export const resolveClaudeProjectRoot = resolveCodexProjectRoot;

const visibleFeedback = (feedback: string | null): string | null =>
  feedback !== null && feedback.trim().length > 0 ? feedback : null;

export const handleClaudeHook = async (
  input: unknown,
  options: HandleClaudeHookOptions = {},
): Promise<ClaudeHookOutput> => {
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  const parsed = claudeHookInputSchema.safeParse(input);
  if (!parsed.success) {
    diagnostics("Rejected malformed Claude hook input; continuing.");
    return {};
  }

  try {
    const projectRoot = await (
      options.resolveProjectRoot ?? resolveClaudeProjectRoot
    )(parsed.data.cwd);
    const coordinator =
      options.source === undefined
        ? undefined
        : (options.duplicateCoordinator ??
          (await createClaudeDuplicateCoordinator(
            projectRoot,
            parsed.data.session_id,
          )));
    if (coordinator !== undefined && options.source !== undefined) {
      const preflight = await coordinator.preflight(
        options.source,
        parsed.data.hook_event_name,
      );
      if (preflight.action === "defer") return {};
      if (preflight.action === "duplicate") {
        return { systemMessage: CLAUDE_DUPLICATE_REMEDIATION };
      }
    }
    const guard = (options.growthGuardFactory ?? createGrowthGuard)({
      projectRoot,
      sessionId: parsed.data.session_id,
      compatibility: CLAUDE_HOOK_ADAPTER_COMPATIBILITY,
    });

    switch (parsed.data.hook_event_name) {
      case "SessionStart": {
        const result = await guard.context();
        if (
          coordinator !== undefined &&
          options.source !== undefined &&
          !(await coordinator.claim(
            options.source,
            "SessionStart",
            result.report.diffFingerprint,
          ))
        )
          return {};
        if (result.report.skippedReason === "growth-mode-disabled") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: result.initialized
              ? "Braid Growth Mode active — architecture baseline captured."
              : "Braid Growth Mode active — architecture baseline recovered.",
          },
        };
      }
      case "UserPromptSubmit":
        {
          const result = await guard.context();
          if (
            coordinator !== undefined &&
            options.source !== undefined &&
            !(await coordinator.claim(
              options.source,
              "UserPromptSubmit",
              result.report.diffFingerprint,
            ))
          )
            return {};
        }
        return {};
      case "PostToolUse": {
        if (!relevantMutationTools.has(parsed.data.tool_name)) return {};
        const result = await guard.check();
        if (
          coordinator !== undefined &&
          options.source !== undefined &&
          !(await coordinator.claim(
            options.source,
            "PostToolUse",
            result.report.diffFingerprint,
          ))
        )
          return {};
        const feedback = visibleFeedback(result.feedback);
        return feedback === null
          ? {}
          : {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: feedback,
              },
            };
      }
      case "Stop": {
        if (coordinator !== undefined && options.source !== undefined) {
          const preview = await guard.check();
          // A continued Stop is a legitimate second lifecycle event, while two
          // invocations with the same active state are adapter duplicates.
          const invocationFingerprint = `${preview.report.diffFingerprint}:${parsed.data.stop_hook_active ? "continued" : "initial"}`;
          if (
            !(await coordinator.claim(
              options.source,
              "Stop",
              invocationFingerprint,
            ))
          )
            return {};
        }
        const result = await guard.final();
        const feedback = visibleFeedback(result.feedback);
        if (result.shouldBlock) {
          return {
            decision: "block",
            reason:
              feedback ??
              "Braid Growth Mode found a blocking architecture regression.",
          };
        }
        if (result.unresolvedCompletion) {
          return {
            systemMessage: `${feedback ?? "Braid Growth Mode found an unresolved architecture regression."}\n\nCompletion is allowed because this unchanged regression fingerprint was already blocked.`,
          };
        }
        return feedback === null ? {} : { systemMessage: feedback };
      }
    }
  } catch {
    diagnostics("Claude hook analysis failed open; continuing.");
    return {};
  }
};

const readInput = async (input: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const writeOutput = async (output: Writable, value: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    output.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

export interface RunClaudeHookStdioOptions extends HandleClaudeHookOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export const runClaudeHookStdio = async (
  options: RunClaudeHookStdioOptions = {},
): Promise<void> => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const diagnostics =
    options.diagnostics ??
    ((message: string) => stderr.write(`[braid-growth] ${message}\n`));
  let input: unknown;
  try {
    input = JSON.parse(await readInput(stdin)) as unknown;
  } catch {
    diagnostics("Claude hook stdin was not one valid JSON value; continuing.");
    input = null;
  }
  const handleOptions: HandleClaudeHookOptions = { diagnostics };
  if (options.growthGuardFactory !== undefined) {
    handleOptions.growthGuardFactory = options.growthGuardFactory;
  }
  if (options.resolveProjectRoot !== undefined) {
    handleOptions.resolveProjectRoot = options.resolveProjectRoot;
  }
  if (options.source !== undefined) handleOptions.source = options.source;
  if (options.duplicateCoordinator !== undefined) {
    handleOptions.duplicateCoordinator = options.duplicateCoordinator;
  }
  const result = claudeHookOutputSchema.parse(
    await handleClaudeHook(input, handleOptions),
  );
  await writeOutput(stdout, `${JSON.stringify(result)}\n`);
};
