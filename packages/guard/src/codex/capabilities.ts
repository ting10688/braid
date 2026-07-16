import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GrowthModeAdapterCompatibility } from "@braid/core";

import { GROWTH_GUARD_VERSION } from "../contracts.js";

const execFileAsync = promisify(execFile);

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export const CODEX_HOOK_TIMEOUT_SECONDS = 30 as const;
export const MINIMUM_CODEX_HOOK_VERSION = "0.144.2" as const;
export const MAXIMUM_CODEX_HOOK_VERSION_EXCLUSIVE = "0.145.0" as const;

export interface CommandResult {
  stdout: string;
  stderr?: string;
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<CommandResult>;

export interface CodexHookCapabilityProbe {
  provider: "codex";
  executable: string;
  version: string | null;
  hookFeature: {
    stage: string | null;
    enabled: boolean;
  };
  requiredEvents: readonly (typeof CODEX_HOOK_EVENTS)[number][];
  supportedEvents: readonly (typeof CODEX_HOOK_EVENTS)[number][];
  capabilities: GrowthModeAdapterCompatibility["capabilities"];
  repositoryConfigPath: ".codex/hooks.json";
  timeoutSeconds: number;
  supported: boolean;
  reason: string | null;
}

export interface ProbeCodexHookCapabilitiesOptions {
  codexExecutable?: string;
  runCommand?: CommandRunner;
}

export const runCommand: CommandRunner = async (command, arguments_) => {
  const result = await execFileAsync(command, [...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const parseVersion = (output: string): string | null =>
  /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? null;

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const unsupportedProbe = (
  executable: string,
  reason: string,
  version: string | null = null,
  stage: string | null = null,
  enabled = false,
): CodexHookCapabilityProbe => ({
  provider: "codex",
  executable,
  version,
  hookFeature: { stage, enabled },
  requiredEvents: CODEX_HOOK_EVENTS,
  supportedEvents: [],
  capabilities: {
    sessionContext: false,
    promptContext: false,
    postToolContext: false,
    stopBlocking: false,
    repositoryLocalConfiguration: false,
    requiresTrust: true,
  },
  repositoryConfigPath: ".codex/hooks.json",
  timeoutSeconds: CODEX_HOOK_TIMEOUT_SECONDS,
  supported: false,
  reason,
});

export const probeCodexHookCapabilities = async (
  options: ProbeCodexHookCapabilitiesOptions = {},
): Promise<CodexHookCapabilityProbe> => {
  const executable = options.codexExecutable ?? "codex";
  const execute = options.runCommand ?? runCommand;

  let version: string | null = null;
  try {
    version = parseVersion((await execute(executable, ["--version"])).stdout);
  } catch (error) {
    return unsupportedProbe(
      executable,
      `Codex version probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (version === null) {
    return unsupportedProbe(executable, "Codex version could not be parsed.");
  }

  let featureOutput: string;
  try {
    featureOutput = (await execute(executable, ["features", "list"])).stdout;
  } catch (error) {
    return unsupportedProbe(
      executable,
      `Codex hooks feature probe failed: ${error instanceof Error ? error.message : String(error)}`,
      version,
    );
  }

  const hookFeature = /^hooks\s+(\S+)\s+(true|false)$/mu.exec(featureOutput);
  const stage = hookFeature?.[1] ?? null;
  const enabled = hookFeature?.[2] === "true";
  if (!enabled) {
    return unsupportedProbe(
      executable,
      "Codex hooks feature is unavailable or disabled.",
      version,
      stage,
    );
  }
  if (stage !== "stable") {
    return unsupportedProbe(
      executable,
      `Codex hooks feature stage ${stage ?? "unknown"} is outside the verified stable contract.`,
      version,
      stage,
      true,
    );
  }
  if (compareVersions(version, MINIMUM_CODEX_HOOK_VERSION) < 0) {
    return unsupportedProbe(
      executable,
      `Codex ${version} predates the verified hooks contract ${MINIMUM_CODEX_HOOK_VERSION}.`,
      version,
      stage,
      true,
    );
  }
  if (compareVersions(version, MAXIMUM_CODEX_HOOK_VERSION_EXCLUSIVE) >= 0) {
    return unsupportedProbe(
      executable,
      `Codex ${version} is outside the verified hooks contract range >=${MINIMUM_CODEX_HOOK_VERSION} <${MAXIMUM_CODEX_HOOK_VERSION_EXCLUSIVE}.`,
      version,
      stage,
      true,
    );
  }

  return {
    provider: "codex",
    executable,
    version,
    hookFeature: { stage, enabled: true },
    requiredEvents: CODEX_HOOK_EVENTS,
    supportedEvents: CODEX_HOOK_EVENTS,
    capabilities: {
      sessionContext: true,
      promptContext: true,
      postToolContext: true,
      stopBlocking: true,
      repositoryLocalConfiguration: true,
      requiresTrust: true,
    },
    repositoryConfigPath: ".codex/hooks.json",
    timeoutSeconds: CODEX_HOOK_TIMEOUT_SECONDS,
    supported: true,
    reason: null,
  };
};

export const CODEX_HOOK_ADAPTER_COMPATIBILITY: GrowthModeAdapterCompatibility =
  {
    protocolVersion: "1.0.0",
    adapter: "codex-hooks",
    adapterVersion: GROWTH_GUARD_VERSION,
    providerVersion: null,
    supportedEvents: [...CODEX_HOOK_EVENTS],
    capabilities: {
      sessionContext: true,
      promptContext: true,
      postToolContext: true,
      stopBlocking: true,
      repositoryLocalConfiguration: true,
      requiresTrust: true,
    },
  };
