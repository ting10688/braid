import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import type { GrowthGuardFactory } from "../contracts.js";
import {
  GROWTH_HOOK_FAIL_OPEN_MESSAGE,
  handleGrowthLifecycle,
  resolveGrowthProjectRoot,
  type GrowthLifecycleEvent,
} from "../native/lifecycle.js";
import { CODEX_HOOK_ADAPTER_COMPATIBILITY } from "./capabilities.js";

const commonInputFields = {
  session_id: z.string().min(1),
  transcript_path: z.string().min(1).nullable(),
  cwd: z.string().min(1),
  model: z.string().min(1),
};

const turnInputFields = {
  ...commonInputFields,
  turn_id: z.string().min(1),
  permission_mode: z.string().min(1),
};

export const codexSessionStartInputSchema = z
  .object({
    ...commonInputFields,
    hook_event_name: z.literal("SessionStart"),
    permission_mode: z.string().min(1),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .passthrough();

export const codexUserPromptSubmitInputSchema = z
  .object({
    ...turnInputFields,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z.string(),
  })
  .passthrough();

export const codexPostToolUseInputSchema = z
  .object({
    ...turnInputFields,
    hook_event_name: z.literal("PostToolUse"),
    tool_name: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_input: z.unknown(),
    tool_response: z.unknown(),
  })
  .passthrough();

export const codexStopInputSchema = z
  .object({
    ...turnInputFields,
    hook_event_name: z.literal("Stop"),
    stop_hook_active: z.boolean(),
    last_assistant_message: z.string().nullable(),
  })
  .passthrough();

export const codexHookInputSchema = z.discriminatedUnion("hook_event_name", [
  codexSessionStartInputSchema,
  codexUserPromptSubmitInputSchema,
  codexPostToolUseInputSchema,
  codexStopInputSchema,
]);

const sessionContextOutputSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("SessionStart"),
        additionalContext: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const promptContextOutputSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("UserPromptSubmit"),
        additionalContext: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const postToolContextOutputSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("PostToolUse"),
        additionalContext: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const codexContinueOutputSchema = z
  .object({
    continue: z.literal(true),
    systemMessage: z.string().min(1).optional(),
  })
  .strict();

export const codexStopBlockOutputSchema = z
  .object({
    decision: z.literal("block"),
    reason: z.string().min(1),
  })
  .strict();

export const codexHookOutputSchema = z.union([
  sessionContextOutputSchema,
  promptContextOutputSchema,
  postToolContextOutputSchema,
  codexContinueOutputSchema,
  codexStopBlockOutputSchema,
]);

export type CodexHookInput = z.infer<typeof codexHookInputSchema>;
export type CodexHookOutput = z.infer<typeof codexHookOutputSchema>;

export type CodexHookDiagnostics = (message: string, error?: unknown) => void;

export interface HandleCodexHookOptions {
  growthGuardFactory?: GrowthGuardFactory;
  diagnostics?: CodexHookDiagnostics;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
}

const defaultDiagnostics: CodexHookDiagnostics = (message, error) => {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  process.stderr.write(`[braid-growth] ${message}${detail}\n`);
};

export const resolveCodexProjectRoot = resolveGrowthProjectRoot;

const failOpen = (): CodexHookOutput => ({
  continue: true,
  systemMessage: GROWTH_HOOK_FAIL_OPEN_MESSAGE,
});

const lifecycleEvent: Record<
  CodexHookInput["hook_event_name"],
  GrowthLifecycleEvent
> = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt-submit",
  PostToolUse: "post-mutation",
  Stop: "final-stop",
};

export const handleCodexHook = async (
  input: unknown,
  options: HandleCodexHookOptions = {},
): Promise<CodexHookOutput> => {
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  const parsed = codexHookInputSchema.safeParse(input);
  if (!parsed.success) {
    diagnostics("Rejected malformed Codex hook input", parsed.error);
    return failOpen();
  }

  try {
    const result = await handleGrowthLifecycle(
      {
        event: lifecycleEvent[parsed.data.hook_event_name],
        cwd: parsed.data.cwd,
        sessionId: parsed.data.session_id,
      },
      {
        compatibility: CODEX_HOOK_ADAPTER_COMPATIBILITY,
        ...(options.growthGuardFactory
          ? { growthGuardFactory: options.growthGuardFactory }
          : {}),
        ...(options.resolveProjectRoot
          ? { resolveProjectRoot: options.resolveProjectRoot }
          : {}),
      },
    );

    if (result.action === "block") {
      return { decision: "block", reason: result.reason };
    }
    if (result.action === "allow") {
      return {
        continue: true,
        ...(result.message ? { systemMessage: result.message } : {}),
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: parsed.data.hook_event_name,
        additionalContext: result.text,
      },
    } as CodexHookOutput;
  } catch (error) {
    diagnostics("Codex hook analysis failed open", error);
    return failOpen();
  }
};

const readInput = async (input: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new Error("Codex hook stdin exceeds the 1 MiB limit.");
    }
    chunks.push(buffer);
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

export interface RunCodexHookStdioOptions extends HandleCodexHookOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export const runCodexHookStdio = async (
  options: RunCodexHookStdioOptions = {},
): Promise<void> => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const diagnostics: CodexHookDiagnostics =
    options.diagnostics ??
    ((message, error) => {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      stderr.write(`[braid-growth] ${message}${detail}\n`);
    });

  let input: unknown;
  const rawInput = await readInput(stdin);
  try {
    input = JSON.parse(rawInput) as unknown;
  } catch (error) {
    diagnostics("Codex hook stdin was not one valid JSON value", error);
    input = rawInput;
  }

  const handleOptions: HandleCodexHookOptions = { diagnostics };
  if (options.growthGuardFactory !== undefined) {
    handleOptions.growthGuardFactory = options.growthGuardFactory;
  }
  if (options.resolveProjectRoot !== undefined) {
    handleOptions.resolveProjectRoot = options.resolveProjectRoot;
  }
  const result = codexHookOutputSchema.parse(
    await handleCodexHook(input, handleOptions),
  );
  await writeOutput(stdout, `${JSON.stringify(result)}\n`);
};
