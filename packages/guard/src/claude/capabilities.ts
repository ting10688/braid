import path from "node:path";

import type { GrowthModeAdapterCompatibility } from "@braid/core";

import { GROWTH_GUARD_VERSION } from "../contracts.js";
import { runCommand, type CommandRunner } from "../codex/capabilities.js";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export const CLAUDE_HOOK_TIMEOUT_SECONDS = 30 as const;
export const CLAUDE_CODE_SUPPORTED_VERSION = "2.1.215" as const;

type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export interface ClaudeHookCapabilityProbe {
  provider: "claude";
  executable: string;
  version: string | null;
  requiredEvents: readonly ClaudeHookEvent[];
  supportedEvents: readonly ClaudeHookEvent[];
  capabilities: GrowthModeAdapterCompatibility["capabilities"];
  repositoryConfigPath: ".claude/settings.local.json";
  timeoutSeconds: number;
  supported: boolean;
  reason: string | null;
}

export interface ProbeClaudeHookCapabilitiesOptions {
  claudeExecutable?: string;
  runCommand?: CommandRunner;
}

export interface ClaudeNativePluginInspection {
  id: "braid@braid";
  installed: boolean;
  enabled: boolean;
  reason: string | null;
}

const parseVersion = (output: string): string | null =>
  /(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?/u.exec(output)?.[1] ?? null;

const unsupported = (
  executable: string,
  reason: string,
  version: string | null = null,
): ClaudeHookCapabilityProbe => ({
  provider: "claude",
  executable: path.basename(executable),
  version,
  requiredEvents: CLAUDE_HOOK_EVENTS,
  supportedEvents: [],
  capabilities: {
    sessionContext: false,
    promptContext: false,
    postToolContext: false,
    stopBlocking: false,
    repositoryLocalConfiguration: false,
    requiresTrust: true,
  },
  repositoryConfigPath: ".claude/settings.local.json",
  timeoutSeconds: CLAUDE_HOOK_TIMEOUT_SECONDS,
  supported: false,
  reason,
});

export const probeClaudeHookCapabilities = async (
  options: ProbeClaudeHookCapabilitiesOptions = {},
): Promise<ClaudeHookCapabilityProbe> => {
  const executable = options.claudeExecutable ?? "claude";
  const execute = options.runCommand ?? runCommand;
  let version: string | null = null;
  try {
    version = parseVersion((await execute(executable, ["--version"])).stdout);
  } catch {
    return unsupported(executable, "Claude Code version probe failed.");
  }
  if (version === null) {
    return unsupported(executable, "Claude Code version could not be parsed.");
  }
  if (version !== CLAUDE_CODE_SUPPORTED_VERSION) {
    return unsupported(
      executable,
      `Claude Code ${version} is outside the verified native-plugin contract ${CLAUDE_CODE_SUPPORTED_VERSION}.`,
      version,
    );
  }

  return {
    provider: "claude",
    executable: path.basename(executable),
    version,
    requiredEvents: CLAUDE_HOOK_EVENTS,
    supportedEvents: CLAUDE_HOOK_EVENTS,
    capabilities: {
      sessionContext: true,
      promptContext: true,
      postToolContext: true,
      stopBlocking: true,
      repositoryLocalConfiguration: true,
      requiresTrust: true,
    },
    repositoryConfigPath: ".claude/settings.local.json",
    timeoutSeconds: CLAUDE_HOOK_TIMEOUT_SECONDS,
    supported: true,
    reason: null,
  };
};

export const inspectClaudeNativePlugin = async (
  options: ProbeClaudeHookCapabilitiesOptions = {},
): Promise<ClaudeNativePluginInspection> => {
  const executable = options.claudeExecutable ?? "claude";
  const execute = options.runCommand ?? runCommand;
  try {
    const parsed = JSON.parse(
      (await execute(executable, ["plugin", "list", "--json"])).stdout,
    ) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        id: "braid@braid",
        installed: false,
        enabled: false,
        reason: "Claude plugin list returned an unexpected shape.",
      };
    }
    const braid = parsed.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        entry.id === "braid@braid",
    );
    if (braid === undefined || typeof braid !== "object" || braid === null) {
      return {
        id: "braid@braid",
        installed: false,
        enabled: false,
        reason: null,
      };
    }
    return {
      id: "braid@braid",
      installed: true,
      enabled: "enabled" in braid && braid.enabled === true,
      reason: null,
    };
  } catch {
    return {
      id: "braid@braid",
      installed: false,
      enabled: false,
      reason: "Claude native plugin inspection failed.",
    };
  }
};

export const CLAUDE_HOOK_ADAPTER_COMPATIBILITY: GrowthModeAdapterCompatibility =
  {
    protocolVersion: "1.0.0",
    adapter: "claude-hooks",
    adapterVersion: GROWTH_GUARD_VERSION,
    providerVersion: CLAUDE_CODE_SUPPORTED_VERSION,
    supportedEvents: [...CLAUDE_HOOK_EVENTS],
    capabilities: {
      sessionContext: true,
      promptContext: true,
      postToolContext: true,
      stopBlocking: true,
      repositoryLocalConfiguration: true,
      requiresTrust: true,
    },
  };
