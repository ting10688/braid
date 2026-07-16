import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { z } from "zod";

import type { GrowthGuardFactory } from "../contracts.js";
import { createGrowthGuard } from "../growth-guard.js";
import { CODEX_HOOK_ADAPTER_COMPATIBILITY } from "./capabilities.js";

const execFileAsync = promisify(execFile);

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

const FAIL_OPEN_MESSAGE =
  "Braid Growth Guard could not evaluate this event; continuing without a pass result. Review hook diagnostics and run `braid growth check`.";

const defaultDiagnostics: CodexHookDiagnostics = (message, error) => {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  process.stderr.write(`[braid-growth] ${message}${detail}\n`);
};

export const resolveCodexProjectRoot = async (cwd: string): Promise<string> => {
  const resolvedCwd = await realpath(path.resolve(cwd));
  const result = await execFileAsync(
    "git",
    ["-C", resolvedCwd, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    },
  );
  const reportedRoot = result.stdout.trim();
  if (reportedRoot.length === 0) {
    throw new Error("Codex hook cwd is not inside a Git repository.");
  }
  const projectRoot = await realpath(reportedRoot);
  const relativeCwd = path.relative(projectRoot, resolvedCwd);
  if (relativeCwd.startsWith(`..${path.sep}`) || relativeCwd === "..") {
    throw new Error("Codex hook cwd resolved outside its Git root.");
  }
  const config = await stat(
    path.join(projectRoot, ".braid", "architecture.yaml"),
  );
  if (!config.isFile()) {
    throw new Error("Braid architecture configuration is not a file.");
  }
  return projectRoot;
};

const failOpen = (): CodexHookOutput => ({
  continue: true,
  systemMessage: FAIL_OPEN_MESSAGE,
});

const requireContext = (text: string): string => {
  if (text.trim().length === 0) {
    throw new Error("Growth Guard returned empty hook context.");
  }
  return text;
};

const visibleFeedback = (feedback: string | null): string | null =>
  feedback !== null && feedback.trim().length > 0 ? feedback : null;

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
    const projectRoot = await (
      options.resolveProjectRoot ?? resolveCodexProjectRoot
    )(parsed.data.cwd);
    const factory = options.growthGuardFactory ?? createGrowthGuard;
    const guard = factory({
      projectRoot,
      sessionId: parsed.data.session_id,
      compatibility: CODEX_HOOK_ADAPTER_COMPATIBILITY,
    });

    switch (parsed.data.hook_event_name) {
      case "SessionStart": {
        const result = await guard.context();
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: requireContext(result.text),
          },
        };
      }
      case "UserPromptSubmit": {
        const result = await guard.context();
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: requireContext(result.text),
          },
        };
      }
      case "PostToolUse": {
        const result = await guard.check();
        const feedback = visibleFeedback(result.feedback);
        if (feedback === null) return { continue: true };
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: feedback,
          },
        };
      }
      case "Stop": {
        const result = await guard.final();
        const feedback = visibleFeedback(result.feedback);
        if (result.shouldBlock) {
          return {
            decision: "block",
            reason:
              feedback ??
              "Braid Growth Guard found a blocking architecture regression.",
          };
        }
        if (result.unresolvedCompletion) {
          return {
            continue: true,
            systemMessage:
              feedback === null
                ? "Braid Growth Guard is allowing completion with an unresolved architecture regression already reported for this fingerprint."
                : `${feedback}\n\nCompletion is allowed because this unchanged regression fingerprint was already blocked once.`,
          };
        }
        if (feedback !== null) {
          return { continue: true, systemMessage: feedback };
        }
        return { continue: true };
      }
    }
  } catch (error) {
    diagnostics("Codex hook analysis failed open", error);
    return failOpen();
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
