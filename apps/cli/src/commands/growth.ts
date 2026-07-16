import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_HOOK_EVENTS,
  createGrowthGuard,
  formatGrowthModeReport,
  inspectCodexHookInstallation,
  installCodexHooks,
  probeCodexHookCapabilities,
  runCodexHookStdio,
  uninstallCodexHooks,
} from "@braid/guard";
import { InvalidInputError } from "@braid/shared";

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
  options: SessionOptions & { codex?: string },
): Promise<void> => {
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

export const growthHookCommand = async (): Promise<void> => {
  await runCodexHookStdio();
};
