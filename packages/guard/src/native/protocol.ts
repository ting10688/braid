import type { Readable, Writable } from "node:stream";

import { z } from "zod";
import type { GrowthModeAdapterCompatibility } from "@braid/core";

import type { GrowthGuardFactory } from "../contracts.js";
import { GROWTH_GUARD_VERSION } from "../contracts.js";
import {
  codexHookInputSchema,
  codexHookOutputSchema,
  handleCodexHook,
  type CodexHookOutput,
} from "../codex/protocol.js";
import { inspectCodexHookInstallation } from "../codex/installer.js";
import {
  GROWTH_HOOK_FAIL_OPEN_MESSAGE,
  handleGrowthLifecycle,
  resolveGrowthProjectRoot,
  type GrowthLifecycleEvent,
  type GrowthLifecycleResult,
} from "./lifecycle.js";

export const NATIVE_AGENT_HOSTS = ["codex", "gemini", "copilot"] as const;
export type NativeAgentHost = (typeof NATIVE_AGENT_HOSTS)[number];

export const NATIVE_HOOK_EVENTS = {
  codex: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
  gemini: ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"],
  copilot: ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"],
} as const;

export type NativeHookEvent =
  (typeof NATIVE_HOOK_EVENTS)[NativeAgentHost][number];

const geminiCommon = {
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  timestamp: z.string().min(1),
};

export const geminiHookInputSchema = z.discriminatedUnion("hook_event_name", [
  z
    .object({
      ...geminiCommon,
      hook_event_name: z.literal("SessionStart"),
      source: z.enum(["startup", "resume", "clear"]),
    })
    .passthrough(),
  z
    .object({
      ...geminiCommon,
      hook_event_name: z.literal("BeforeAgent"),
      prompt: z.string(),
    })
    .passthrough(),
  z
    .object({
      ...geminiCommon,
      hook_event_name: z.literal("AfterTool"),
      tool_name: z.string().min(1),
      tool_input: z.unknown(),
      tool_response: z.unknown(),
    })
    .passthrough(),
  z
    .object({
      ...geminiCommon,
      hook_event_name: z.literal("AfterAgent"),
      prompt: z.string(),
      prompt_response: z.string(),
      stop_hook_active: z.boolean(),
    })
    .passthrough(),
]);

const copilotCommon = {
  sessionId: z.string().min(1),
  timestamp: z.number(),
  cwd: z.string().min(1),
};

export const copilotHookInputSchemas = {
  sessionStart: z
    .object({
      ...copilotCommon,
      source: z.enum(["startup", "resume", "new"]),
      initialPrompt: z.string().optional(),
    })
    .passthrough(),
  userPromptSubmitted: z
    .object({ ...copilotCommon, prompt: z.string() })
    .passthrough(),
  postToolUse: z
    .object({
      ...copilotCommon,
      toolName: z.string().min(1),
      toolArgs: z.unknown(),
      toolResult: z.unknown(),
    })
    .passthrough(),
  agentStop: z
    .object({
      ...copilotCommon,
      transcriptPath: z.string().min(1),
      stopReason: z.string().min(1),
    })
    .passthrough(),
} as const;

const contextOutputSchema = z
  .object({
    hookSpecificOutput: z
      .object({ additionalContext: z.string().min(1) })
      .strict(),
  })
  .strict();
const allowOutputSchema = z
  .object({
    decision: z.literal("allow"),
    systemMessage: z.string().min(1).optional(),
  })
  .strict();
const blockOutputSchema = z
  .object({ decision: z.literal("block"), reason: z.string().min(1) })
  .strict();
const denyOutputSchema = z
  .object({ decision: z.literal("deny"), reason: z.string().min(1) })
  .strict();
const emptyOutputSchema = z.object({}).strict();

export const geminiHookOutputSchema = z.union([
  contextOutputSchema,
  allowOutputSchema,
  denyOutputSchema,
  emptyOutputSchema,
]);
export const copilotHookOutputSchema = z.union([
  z.object({ additionalContext: z.string().min(1) }).strict(),
  allowOutputSchema,
  blockOutputSchema,
  emptyOutputSchema,
]);

export type GeminiHookOutput = z.infer<typeof geminiHookOutputSchema>;
export type CopilotHookOutput = z.infer<typeof copilotHookOutputSchema>;

const GEMINI_COMPATIBILITY: GrowthModeAdapterCompatibility = {
  protocolVersion: "1.0.0",
  adapter: "gemini-extension",
  adapterVersion: GROWTH_GUARD_VERSION,
  providerVersion: null,
  supportedEvents: [...NATIVE_HOOK_EVENTS.gemini],
  capabilities: {
    sessionContext: true,
    promptContext: true,
    postToolContext: true,
    stopBlocking: true,
    repositoryLocalConfiguration: false,
    requiresTrust: true,
  },
};

const COPILOT_COMPATIBILITY: GrowthModeAdapterCompatibility = {
  protocolVersion: "1.0.0",
  adapter: "copilot-cli-plugin",
  adapterVersion: GROWTH_GUARD_VERSION,
  providerVersion: null,
  supportedEvents: [...NATIVE_HOOK_EVENTS.copilot],
  capabilities: {
    sessionContext: true,
    promptContext: false,
    postToolContext: true,
    stopBlocking: true,
    repositoryLocalConfiguration: false,
    requiresTrust: true,
  },
};

export type NativeHookDiagnostics = (message: string, error?: unknown) => void;

export interface HandleNativeHookOptions {
  growthGuardFactory?: GrowthGuardFactory;
  diagnostics?: NativeHookDiagnostics;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
  nativePlugin?: boolean;
}

const defaultDiagnostics: NativeHookDiagnostics = (message, error) => {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  process.stderr.write(`[braid-growth] ${message}${detail}\n`);
};

const eventFor = (host: NativeAgentHost, event: NativeHookEvent) => {
  const events: Record<
    NativeAgentHost,
    Record<string, GrowthLifecycleEvent>
  > = {
    codex: {
      SessionStart: "session-start",
      UserPromptSubmit: "prompt-submit",
      PostToolUse: "post-mutation",
      Stop: "final-stop",
    },
    gemini: {
      SessionStart: "session-start",
      BeforeAgent: "prompt-submit",
      AfterTool: "post-mutation",
      AfterAgent: "final-stop",
    },
    copilot: {
      sessionStart: "session-start",
      userPromptSubmitted: "prompt-submit",
      postToolUse: "post-mutation",
      agentStop: "final-stop",
    },
  };
  const normalized = events[host][event];
  if (!normalized) throw new Error(`Unsupported ${host} hook event ${event}.`);
  return normalized;
};

const translateGemini = (result: GrowthLifecycleResult): GeminiHookOutput => {
  if (result.action === "block") {
    return { decision: "deny", reason: result.reason };
  }
  if (result.action === "context") {
    return { hookSpecificOutput: { additionalContext: result.text } };
  }
  return result.message
    ? { decision: "allow", systemMessage: result.message }
    : {};
};

const translateCopilot = (
  event: NativeHookEvent,
  result: GrowthLifecycleResult,
): CopilotHookOutput => {
  if (result.action === "block") {
    return { decision: "block", reason: result.reason };
  }
  if (event === "userPromptSubmitted") return {};
  if (result.action === "context") return { additionalContext: result.text };
  return event === "agentStop" ? { decision: "allow" } : {};
};

const failOpen = (host: NativeAgentHost, event: NativeHookEvent) => {
  if (host === "codex") {
    return {
      continue: true,
      systemMessage: GROWTH_HOOK_FAIL_OPEN_MESSAGE,
    } satisfies CodexHookOutput;
  }
  if (host === "copilot" && event === "agentStop") {
    return { decision: "allow" } satisfies CopilotHookOutput;
  }
  return {};
};

export const handleNativeHook = async (
  host: NativeAgentHost,
  event: NativeHookEvent,
  input: unknown,
  options: HandleNativeHookOptions = {},
): Promise<CodexHookOutput | GeminiHookOutput | CopilotHookOutput> => {
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  try {
    if (host === "codex") {
      const parsed = codexHookInputSchema.safeParse(input);
      if (!parsed.success) throw parsed.error;
      if (options.nativePlugin) {
        const root = await (
          options.resolveProjectRoot ?? resolveGrowthProjectRoot
        )(parsed.data.cwd);
        if ((await inspectCodexHookInstallation(root)).installed) {
          diagnostics(
            "Both the native Codex plugin and manual Codex adapter are installed; the plugin invocation is failing open. Run `braid growth uninstall codex` to keep only the native plugin.",
          );
          return failOpen(host, event);
        }
      }
      return await handleCodexHook(input, {
        diagnostics,
        ...(options.growthGuardFactory
          ? { growthGuardFactory: options.growthGuardFactory }
          : {}),
        ...(options.resolveProjectRoot
          ? { resolveProjectRoot: options.resolveProjectRoot }
          : {}),
      });
    }

    let sessionId: string;
    let cwd: string;
    let compatibility: GrowthModeAdapterCompatibility;
    if (host === "gemini") {
      const parsed = geminiHookInputSchema.parse(input);
      if (parsed.hook_event_name !== event) {
        throw new Error(
          `Gemini hook payload event ${parsed.hook_event_name} does not match ${event}.`,
        );
      }
      sessionId = parsed.session_id;
      cwd = parsed.cwd;
      compatibility = GEMINI_COMPATIBILITY;
    } else {
      if (!(event in copilotHookInputSchemas)) {
        throw new Error(`Unsupported Copilot hook event ${event}.`);
      }
      const schema =
        copilotHookInputSchemas[event as keyof typeof copilotHookInputSchemas];
      const parsed = schema.parse(input);
      sessionId = parsed.sessionId;
      cwd = parsed.cwd;
      compatibility = COPILOT_COMPATIBILITY;
    }

    const result = await handleGrowthLifecycle(
      { event: eventFor(host, event), sessionId, cwd },
      {
        compatibility,
        ...(options.growthGuardFactory
          ? { growthGuardFactory: options.growthGuardFactory }
          : {}),
        ...(options.resolveProjectRoot
          ? { resolveProjectRoot: options.resolveProjectRoot }
          : {}),
      },
    );
    return host === "gemini"
      ? translateGemini(result)
      : translateCopilot(event, result);
  } catch (error) {
    diagnostics(`${host} hook analysis failed open`, error);
    return failOpen(host, event);
  }
};

const readBoundedInput = async (input: Readable): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new Error("Native hook stdin exceeds the 1 MiB limit.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const writeOutput = async (output: Writable, value: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    output.write(value, (error) => (error ? reject(error) : resolve()));
  });
};

export interface RunNativeHookStdioOptions extends HandleNativeHookOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export const runNativeHookStdio = async (
  host: NativeAgentHost,
  event: NativeHookEvent,
  options: RunNativeHookStdioOptions = {},
): Promise<void> => {
  const stderr = options.stderr ?? process.stderr;
  const diagnostics: NativeHookDiagnostics =
    options.diagnostics ??
    ((message, error) => {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      stderr.write(`[braid-growth] ${message}${detail}\n`);
    });
  let input: unknown;
  try {
    input = await readBoundedInput(options.stdin ?? process.stdin);
  } catch (error) {
    diagnostics(`${host} hook stdin was not one bounded JSON value`, error);
    input = null;
  }
  const result = await handleNativeHook(host, event, input, {
    diagnostics,
    nativePlugin: options.nativePlugin ?? true,
    ...(options.growthGuardFactory
      ? { growthGuardFactory: options.growthGuardFactory }
      : {}),
    ...(options.resolveProjectRoot
      ? { resolveProjectRoot: options.resolveProjectRoot }
      : {}),
  });
  const schema =
    host === "codex"
      ? codexHookOutputSchema
      : host === "gemini"
        ? geminiHookOutputSchema
        : copilotHookOutputSchema;
  await writeOutput(
    options.stdout ?? process.stdout,
    `${JSON.stringify(schema.parse(result))}\n`,
  );
};
