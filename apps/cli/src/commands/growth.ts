import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchitectureConfig } from "@braid/core";
import {
  CODEX_HOOK_EVENTS,
  createGrowthGuard,
  formatGrowthModeReport,
  inspectCodexHookInstallation,
  installCodexHooks,
  NATIVE_AGENT_HOSTS,
  NATIVE_HOOK_EVENTS,
  probeNativeAgent,
  probeCodexHookCapabilities,
  runCodexHookStdio,
  runNativeHookStdio,
  uninstallCodexHooks,
  type NativeAgentHost,
  type NativeHookEvent,
} from "@braid/guard";
import { CONFIG_FILE, InvalidInputError } from "@braid/shared";
import { BRAID_CLI_VERSION } from "../version.js";

interface SessionOptions {
  path: string;
  session?: string;
  json?: boolean;
}

interface InstallOptions {
  path: string;
  dryRun?: boolean;
  confirm?: boolean;
  codex?: string;
  json?: boolean;
}

interface UninstallOptions {
  path: string;
  dryRun?: boolean;
  json?: boolean;
}

interface ResetOptions extends SessionOptions {
  confirm?: string;
}

interface NativeSetupOptions {
  path: string;
  host: string;
  json?: boolean;
}

interface NativeStatusOptions extends SessionOptions {
  codex?: string;
  host?: string;
}

const sessionIdFor = (session: string | undefined): string =>
  session ?? process.env.CODEX_THREAD_ID ?? "manual";

const guardFor = (options: SessionOptions) =>
  createGrowthGuard({
    projectRoot: path.resolve(options.path),
    sessionId: sessionIdFor(options.session),
  });

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const nativeHost = (value: string): NativeAgentHost => {
  if (!NATIVE_AGENT_HOSTS.includes(value as NativeAgentHost)) {
    throw new InvalidInputError(`Unsupported native agent host ${value}.`);
  }
  return value as NativeAgentHost;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const redactedPath = (value: string): string => {
  const absolute = path.resolve(value);
  const home = homedir();
  return absolute === home
    ? "<home>"
    : absolute.startsWith(`${home}${path.sep}`)
      ? `<home>${path.sep}${path.relative(home, absolute)}`
      : absolute;
};

const nativeInstallCommand: Record<NativeAgentHost, string> = {
  codex: "codex plugin add braid@braid",
  gemini: "gemini extensions install <released-braid-extension-source>",
  copilot: "copilot plugin install braid@braid",
};

const inspectNativeStatus = async (
  options: NativeSetupOptions & { session?: string; codex?: string },
) => {
  const host = nativeHost(options.host);
  const projectRoot = path.resolve(options.path);
  const configPath = path.join(projectRoot, CONFIG_FILE);
  const initialized = await exists(configPath);
  let growthEnabled = false;
  let configurationValid = true;
  if (initialized) {
    try {
      growthEnabled = (await loadArchitectureConfig(configPath)).growthMode
        .enabled;
    } catch {
      configurationValid = false;
    }
  }

  const probe = await probeNativeAgent(host, {
    workspacePath: projectRoot,
    ...(host === "codex" && options.codex ? { executable: options.codex } : {}),
  });
  let manualCodexAdapter = false;
  if (host === "codex") {
    try {
      manualCodexAdapter = (await inspectCodexHookInstallation(projectRoot))
        .installed;
    } catch {
      // A malformed legacy config is reported by its legacy status command.
    }
  }
  const duplicateAdapter = probe.adapterDiscovered && manualCodexAdapter;

  let lifecycle = null;
  if (initialized && configurationValid) {
    try {
      const state = await guardFor({
        path: projectRoot,
        session: options.session ?? `native-manual-${host}`,
      }).status();
      lifecycle = {
        baselineExists: state.baselineExists,
        latestStatus: state.latestReport?.status ?? null,
        unresolvedCompletion: state.unresolvedCompletion,
      };
    } catch {
      // Setup remains safe and useful outside a Git repository.
    }
  }

  const nextCommand = !probe.supported
    ? `${host} --version`
    : !probe.adapterDiscovered
      ? nativeInstallCommand[host]
      : !initialized
        ? "braid init"
        : !configurationValid
          ? `braid growth setup --host ${host}`
          : !growthEnabled
            ? `braid growth setup --host ${host}`
            : duplicateAdapter
              ? "braid growth uninstall codex"
              : `braid growth status --host ${host}`;

  return {
    host: { name: host, version: probe.version, supported: probe.supported },
    braid: {
      executable: redactedPath(process.argv[1] ?? "braid"),
      version: BRAID_CLI_VERSION,
      supported: BRAID_CLI_VERSION.startsWith("0.6."),
    },
    project: {
      root: ".",
      initialized,
      configurationValid,
      growthEnabled,
    },
    adapter: {
      kind: "native-plugin",
      discovered: probe.adapterDiscovered,
      duplicateManualCodexAdapter: duplicateAdapter,
    },
    session: lifecycle,
    compatibility: probe.classification,
    limitations: probe.limitations,
    reason: probe.reason,
    nextCommand,
  };
};

export const growthSetupCommand = async (
  options: NativeSetupOptions,
): Promise<void> => {
  const status = await inspectNativeStatus(options);
  if (options.json) {
    writeJson(status);
    return;
  }
  process.stdout.write(
    [
      "Braid native adapter setup",
      "",
      `Host: ${status.host.name} ${status.host.version ?? "not found"}`,
      `Host contract supported: ${status.host.supported ? "yes" : "no"}`,
      `Braid CLI: ${status.braid.executable} (${status.braid.version})`,
      `Project initialized: ${status.project.initialized ? "yes" : "no"}`,
      `Configuration valid: ${status.project.configurationValid ? "yes" : "no"}`,
      `Growth Mode enabled: ${status.project.growthEnabled ? "yes" : "no"}`,
      `Native adapter discovered: ${status.adapter.discovered ? "yes" : "no"}`,
      `Compatibility: ${status.compatibility}`,
      ...(status.reason ? [`Note: ${status.reason}`] : []),
      "",
      status.project.initialized &&
      status.project.configurationValid &&
      !status.project.growthEnabled
        ? "Next: review .braid/architecture.yaml, explicitly set growthMode.enabled to true, then run:"
        : "Next command:",
      status.nextCommand,
      "",
    ].join("\n"),
  );
};

export const growthContextCommand = async (
  options: SessionOptions,
): Promise<void> => {
  const result = await guardFor(options).context();
  if (options.json) writeJson(result);
  else process.stdout.write(`${result.text}\n`);
};

export const growthCheckCommand = async (
  options: SessionOptions,
): Promise<void> => {
  const result = await guardFor(options).check();
  if (options.json) writeJson(result.report);
  else
    process.stdout.write(
      `${result.feedback ?? formatGrowthModeReport(result.report)}\n`,
    );
};

export const growthFinalCommand = async (
  options: SessionOptions,
): Promise<void> => {
  const result = await guardFor(options).final();
  if (options.json) writeJson(result);
  else
    process.stdout.write(
      `${result.feedback ?? formatGrowthModeReport(result.report)}\n`,
    );
};

export const growthStatusCommand = async (
  options: NativeStatusOptions,
): Promise<void> => {
  if (options.host) {
    const status = await inspectNativeStatus({
      ...options,
      host: options.host,
    });
    if (options.json) {
      writeJson(status);
      return;
    }
    process.stdout.write(
      [
        "Braid Growth Mode",
        "",
        `Host: ${status.host.name} ${status.host.version ?? "not found"}`,
        `Braid CLI: ${status.braid.executable} (${status.braid.version})`,
        `Project: ${status.project.initialized ? "initialized" : "not initialized"}`,
        `Growth Mode: ${status.project.growthEnabled ? "enabled" : "disabled"}`,
        `Hook discovery: ${status.adapter.discovered ? "native adapter active" : "native adapter not discovered"}`,
        `Session baseline: ${status.session?.baselineExists ? "active" : "not available"}`,
        `Latest result: ${status.session?.latestStatus ?? "none"}`,
        `Unresolved completion: ${status.session?.unresolvedCompletion ? "yes" : "no"}`,
        `Compatibility: ${status.compatibility}`,
        ...(status.adapter.duplicateManualCodexAdapter
          ? [
              "Duplicate adapter: native plugin and manual Codex adapter are both present.",
              "Remediation: braid growth uninstall codex",
            ]
          : []),
        "Known limitations:",
        ...status.limitations.map((limitation) => `- ${limitation}`),
        ...(status.reason ? [`Note: ${status.reason}`] : []),
        "",
      ].join("\n"),
    );
    return;
  }
  const projectRoot = path.resolve(options.path);
  const [lifecycle, installation, capabilities] = await Promise.all([
    guardFor(options).status(),
    inspectCodexHookInstallation(projectRoot),
    probeCodexHookCapabilities({
      ...(options.codex ? { codexExecutable: options.codex } : {}),
    }),
  ]);
  const status = { lifecycle, installation, capabilities };
  if (options.json) {
    writeJson(status);
    return;
  }
  process.stdout.write(
    [
      "Braid Growth Mode",
      "",
      `Enabled: ${lifecycle.enabled ? "yes" : "no"}`,
      `Session: ${lifecycle.sessionId}`,
      `Baseline: ${lifecycle.baseline?.id ?? "not initialized"}`,
      `Baseline Git fingerprint: ${lifecycle.baseline?.gitFingerprint ?? "none"}`,
      `Baseline source fingerprint: ${lifecycle.baseline?.sourceFingerprint ?? "none"}`,
      `Current Git fingerprint: ${lifecycle.current?.gitFingerprint ?? "none"}`,
      `Current source fingerprint: ${lifecycle.current?.sourceFingerprint ?? "none"}`,
      `Current architecture fingerprint: ${lifecycle.current?.architectureFingerprint ?? "none"}`,
      `Latest report: ${lifecycle.latestReport?.status ?? "none"}`,
      `Unresolved completion: ${lifecycle.unresolvedCompletion ? "yes" : "no"}`,
      `Codex hooks installed: ${installation.installed ? "yes" : "no"}`,
      `Codex hooks supported: ${capabilities.supported ? "yes" : "no"}`,
      ...(capabilities.reason
        ? [`Capability note: ${capabilities.reason}`]
        : []),
      "",
    ].join("\n"),
  );
};

export const growthResetCommand = async (
  options: ResetOptions,
): Promise<void> => {
  const sessionId = sessionIdFor(options.session);
  if (options.confirm !== sessionId)
    throw new InvalidInputError(
      `Reset requires --confirm ${sessionId} for the active session.`,
    );
  const removed = await guardFor({ ...options, session: sessionId }).reset();
  const result = { sessionId, removed };
  if (options.json) writeJson(result);
  else
    process.stdout.write(
      `${removed ? "Braid Growth Mode state reset." : "No Braid Growth Mode state existed."}\n`,
    );
};

const cliEntrypoint = (): string =>
  process.argv[1]
    ? path.resolve(process.argv[1])
    : fileURLToPath(new URL("../index.js", import.meta.url));

export const growthInstallCodexCommand = async (
  options: InstallOptions,
): Promise<void> => {
  const result = await installCodexHooks({
    projectRoot: path.resolve(options.path),
    launcher: [process.execPath, cliEntrypoint(), "growth", "hook"],
    dryRun: options.dryRun ?? false,
    confirm: options.confirm ?? false,
    ...(options.codex ? { codexExecutable: options.codex } : {}),
  });
  if (options.json) {
    writeJson(result);
    return;
  }
  process.stdout.write(
    [
      `Braid Codex hook ${result.dryRun ? "dry run" : "installation"}`,
      `Configuration: ${result.configPath}`,
      `Changed: ${result.changed ? "yes" : "no"}`,
      ...CODEX_HOOK_EVENTS.map(
        (event) => `${event}: ${result.events[event] ? "enabled" : "missing"}`,
      ),
      ...(result.backupPath ? [`Backup: ${result.backupPath}`] : []),
      "Trust: review the repository hooks with /hooks in Codex.",
      "",
    ].join("\n"),
  );
};

export const growthUninstallCodexCommand = async (
  options: UninstallOptions,
): Promise<void> => {
  const result = await uninstallCodexHooks({
    projectRoot: path.resolve(options.path),
    dryRun: options.dryRun ?? false,
  });
  if (options.json) {
    writeJson(result);
    return;
  }
  process.stdout.write(
    [
      `Braid Codex hook ${result.dryRun ? "uninstall dry run" : "uninstall"}`,
      `Configuration: ${result.configPath}`,
      `Changed: ${result.changed ? "yes" : "no"}`,
      `Owned handlers removed: ${result.removedHandlerCount}`,
      "",
    ].join("\n"),
  );
};

export const growthHookCommand = async (options: {
  host?: string;
  event?: string;
}): Promise<void> => {
  if (!options.host) {
    await runCodexHookStdio();
    return;
  }
  if (!NATIVE_AGENT_HOSTS.includes(options.host as NativeAgentHost)) {
    throw new InvalidInputError(
      `Unsupported native agent host ${options.host}.`,
    );
  }
  const host = options.host as NativeAgentHost;
  if (
    !options.event ||
    !(NATIVE_HOOK_EVENTS[host] as readonly string[]).includes(options.event)
  ) {
    throw new InvalidInputError(
      `Unsupported ${host} hook event ${options.event ?? "<missing>"}.`,
    );
  }
  await runNativeHookStdio(host, options.event as NativeHookEvent);
};
