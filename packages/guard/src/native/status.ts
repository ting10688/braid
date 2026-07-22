import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  probeCodexHookCapabilities,
  runCommand,
  type CommandRunner,
} from "../codex/capabilities.js";
import type { NativeAgentHost } from "./protocol.js";

export interface NativeAgentProbe {
  host: NativeAgentHost;
  executable: string;
  version: string | null;
  supported: boolean;
  adapterDiscovered: boolean;
  classification: "verified" | "verified-with-limitations";
  limitations: string[];
  reason: string | null;
}

export interface ProbeNativeAgentOptions {
  executable?: string;
  runCommand?: CommandRunner;
  workspacePath?: string;
}

const executables: Record<NativeAgentHost, string> = {
  codex: "codex",
  claude: "claude",
  gemini: "gemini",
  copilot: "copilot",
};

const versionFor = (host: NativeAgentHost, output: string): string | null => {
  const pattern =
    host === "copilot"
      ? /GitHub Copilot CLI\s+(\d+\.\d+\.\d+)/u
      : host === "codex"
        ? /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/u
        : host === "claude"
          ? /(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?/u
          : /^(\d+\.\d+\.\d+)$/mu;
  return pattern.exec(output)?.[1] ?? null;
};

const compareVersion = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const supportedVersion = (host: NativeAgentHost, version: string): boolean => {
  if (host === "codex") {
    return (
      compareVersion(version, "0.144.2") >= 0 &&
      compareVersion(version, "0.145.0") < 0
    );
  }
  if (host === "gemini") {
    return compareVersion(version, "0.40.0") === 0;
  }
  if (host === "claude") {
    return compareVersion(version, "2.1.215") === 0;
  }
  return compareVersion(version, "1.0.71") === 0;
};

const containsBraidPlugin = (output: string): boolean => {
  try {
    const parsed = JSON.parse(output) as unknown;
    const visit = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(visit);
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        if (
          (object.name === "braid" ||
            object.pluginId === "braid@braid" ||
            object.id === "braid@braid") &&
          object.enabled !== false
        ) {
          return true;
        }
        return Object.values(object).some(visit);
      }
      return false;
    };
    return visit(parsed);
  } catch {
    return /(^|\s)braid(?:@braid)?(?=\s|$)/imu.test(output);
  }
};

const geminiExtensionInstalled = async (
  workspacePath: string,
): Promise<boolean> => {
  const configurationRoot = process.env.GEMINI_CLI_HOME ?? homedir();
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          configurationRoot,
          ".gemini",
          "extensions",
          "braid",
          "gemini-extension.json",
        ),
        "utf8",
      ),
    ) as { name?: unknown };
    if (manifest.name !== "braid") return false;
    const enablement = JSON.parse(
      await readFile(
        path.join(
          configurationRoot,
          ".gemini",
          "extensions",
          "extension-enablement.json",
        ),
        "utf8",
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return "{}";
        }
        throw error;
      }),
    ) as { braid?: { overrides?: unknown } };
    const overrides = enablement.braid?.overrides;
    if (!Array.isArray(overrides)) return true;
    const target = `${path.resolve(workspacePath).replaceAll(path.sep, "/")}/`;
    let enabled = true;
    for (const value of overrides) {
      if (typeof value !== "string") continue;
      const disabled = value.startsWith("!");
      const pattern = disabled ? value.slice(1) : value;
      const recursive = pattern.endsWith("*");
      const base = (recursive ? pattern.slice(0, -1) : pattern).replaceAll(
        "\\",
        "/",
      );
      if (recursive ? target.startsWith(base) : target === base) {
        enabled = !disabled;
      }
    }
    return enabled;
  } catch {
    return false;
  }
};

const limitationsFor = (host: NativeAgentHost): string[] => {
  if (host === "codex") {
    return [
      "Plugin hooks require review in /hooks.",
      "Shell mutation interception is incomplete; the final scan is authoritative.",
      "Codex 0.144.5 has no plugin enable/disable CLI subcommand.",
    ];
  }
  if (host === "gemini") {
    return [
      "Extension changes require a new Gemini CLI session.",
      "Folder trust remains a user decision.",
      "The final scan is authoritative for shell mutations.",
    ];
  }
  if (host === "claude") {
    return [
      "Support is exact-version scoped to local Claude Code 2.1.215 on Darwin arm64.",
      "Plugin changes require /reload-plugins or a new Claude Code session.",
      "Shell mutation interception is incomplete; the final scan is authoritative.",
      "Claude web and cloud-agent compatibility are not claimed.",
    ];
  }
  return [
    "Local Copilot CLI scope only; no cloud-agent compatibility is claimed.",
    "userPromptSubmitted stdout is not used for correctness.",
    "Copilot timeouts do not guarantee descendant cleanup.",
    "Copilot CLI 1.0.71 has no working plugin enable/disable command.",
  ];
};

export const probeNativeAgent = async (
  host: NativeAgentHost,
  options: ProbeNativeAgentOptions = {},
): Promise<NativeAgentProbe> => {
  const executable = options.executable ?? executables[host];
  const execute = options.runCommand ?? runCommand;
  const classification =
    host === "copilot" ? "verified-with-limitations" : "verified";
  const limitations = limitationsFor(host);

  if (host === "codex") {
    const capabilities = await probeCodexHookCapabilities({
      codexExecutable: executable,
      runCommand: execute,
    });
    let adapterDiscovered = false;
    if (capabilities.supported) {
      try {
        adapterDiscovered = containsBraidPlugin(
          (await execute(executable, ["plugin", "list", "--json"])).stdout,
        );
      } catch {
        // Status remains useful when plugin listing is unavailable.
      }
    }
    return {
      host,
      executable,
      version: capabilities.version,
      supported: capabilities.supported,
      adapterDiscovered,
      classification,
      limitations,
      reason: capabilities.reason,
    };
  }

  let version: string | null = null;
  try {
    version = versionFor(
      host,
      (await execute(executable, ["--version"])).stdout,
    );
  } catch (error) {
    return {
      host,
      executable,
      version: null,
      supported: false,
      adapterDiscovered: false,
      classification,
      limitations,
      reason: `${host} version probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!version || !supportedVersion(host, version)) {
    return {
      host,
      executable,
      version,
      supported: false,
      adapterDiscovered: false,
      classification,
      limitations,
      reason: version
        ? `${host} ${version} is outside Braid's verified native adapter contract.`
        : `${host} version could not be parsed.`,
    };
  }

  let adapterDiscovered = false;
  try {
    const arguments_ =
      host === "gemini"
        ? ["extensions", "list", "--output-format", "json"]
        : host === "claude"
          ? ["plugin", "list", "--json"]
          : ["plugin", "list"];
    adapterDiscovered = containsBraidPlugin(
      (await execute(executable, arguments_)).stdout,
    );
  } catch {
    // Status remains useful when plugin listing is unavailable.
  }
  if (host === "gemini" && !adapterDiscovered) {
    adapterDiscovered = await geminiExtensionInstalled(
      options.workspacePath ?? process.cwd(),
    );
  }
  return {
    host,
    executable,
    version,
    supported: true,
    adapterDiscovered,
    classification,
    limitations,
    reason: null,
  };
};
