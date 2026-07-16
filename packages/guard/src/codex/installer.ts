import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  probeCodexHookCapabilities,
  type CodexHookCapabilityProbe,
  type CommandRunner,
} from "./capabilities.js";

export const BRAID_CODEX_HOOK_OWNER = "@braid/guard@0.1.0" as const;
export const BRAID_CODEX_HOOK_STATUS =
  `Braid Growth Guard (${BRAID_CODEX_HOOK_OWNER})` as const;

type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
type JsonObject = Record<string, unknown>;

interface HookDocumentRead {
  document: JsonObject;
  exists: boolean;
  raw: string | null;
}

export interface CodexHookInstallationInspection {
  configPath: string;
  exists: boolean;
  installed: boolean;
  events: Record<CodexHookEvent, boolean>;
  ownedHandlerCount: number;
  missingEvents: CodexHookEvent[];
}

export interface InstallCodexHooksOptions {
  projectRoot: string;
  launcher: string[];
  dryRun?: boolean;
  confirm?: boolean;
  codexExecutable?: string;
  runCommand?: CommandRunner;
}

export interface InstallCodexHooksResult extends CodexHookInstallationInspection {
  changed: boolean;
  dryRun: boolean;
  backupPath: string | null;
  capabilityProbe: CodexHookCapabilityProbe;
}

export interface UninstallCodexHooksOptions {
  projectRoot: string;
  dryRun?: boolean;
}

export interface UninstallCodexHooksResult extends CodexHookInstallationInspection {
  changed: boolean;
  dryRun: boolean;
  removedHandlerCount: number;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hooksObject = (document: JsonObject): JsonObject => {
  const hooks = document.hooks;
  if (hooks === undefined) {
    const created: JsonObject = {};
    document.hooks = created;
    return created;
  }
  if (!isObject(hooks)) {
    throw new Error("Codex hooks configuration `hooks` must be an object.");
  }
  return hooks;
};

const validateDocument = (value: unknown): JsonObject => {
  if (!isObject(value)) {
    throw new Error("Codex hooks configuration must be a JSON object.");
  }
  const hooks = hooksObject(value);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Codex hook event ${event} must contain an array.`);
    }
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        throw new Error(
          `Codex hook event ${event} contains an invalid matcher group.`,
        );
      }
      if (!group.hooks.every(isObject)) {
        throw new Error(
          `Codex hook event ${event} contains an invalid hook handler.`,
        );
      }
    }
  }
  return value;
};

const readDocument = async (configPath: string): Promise<HookDocumentRead> => {
  try {
    const raw = await readFile(configPath, "utf8");
    return {
      document: validateDocument(JSON.parse(raw) as unknown),
      exists: true,
      raw,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { document: { hooks: {} }, exists: false, raw: null };
    }
    throw error;
  }
};

const quotePosix = (argument: string): string =>
  `'${argument.replaceAll("'", `'"'"'`)}'`;

export const createCodexHookCommand = (launcher: readonly string[]): string => {
  if (launcher.length === 0 || launcher.some((part) => part.length === 0)) {
    throw new Error("Codex hook launcher must contain non-empty arguments.");
  }
  return [
    `BRAID_GROWTH_HOOK_OWNER=${quotePosix(BRAID_CODEX_HOOK_OWNER)}`,
    ...launcher.map(quotePosix),
  ].join(" ");
};

const isOwnedHandler = (value: unknown): boolean =>
  isObject(value) &&
  value.type === "command" &&
  typeof value.command === "string" &&
  value.command.includes("BRAID_GROWTH_HOOK_OWNER=") &&
  value.command.includes(BRAID_CODEX_HOOK_OWNER) &&
  value.statusMessage === BRAID_CODEX_HOOK_STATUS;

interface RemovalResult {
  groups: unknown[];
  removed: number;
}

const removeOwnedHandlers = (groups: unknown[]): RemovalResult => {
  const retainedGroups: unknown[] = [];
  let removed = 0;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      retainedGroups.push(group);
      continue;
    }
    let removedFromGroup = 0;
    const retainedHandlers = group.hooks.filter((handler) => {
      if (!isOwnedHandler(handler)) return true;
      removed += 1;
      removedFromGroup += 1;
      return false;
    });
    if (retainedHandlers.length > 0 || removedFromGroup === 0) {
      retainedGroups.push({ ...group, hooks: retainedHandlers });
    }
  }
  return { groups: retainedGroups, removed };
};

const canonicalHandler = (command: string): JsonObject => ({
  type: "command",
  command,
  statusMessage: BRAID_CODEX_HOOK_STATUS,
  timeout: CODEX_HOOK_TIMEOUT_SECONDS,
});

const installIntoDocument = (
  original: JsonObject,
  command: string,
): JsonObject => {
  const document = structuredClone(original);
  const hooks = hooksObject(document);
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) {
      throw new Error(`Codex hook event ${event} must contain an array.`);
    }
    const retained = removeOwnedHandlers(groups).groups;
    hooks[event] = [...retained, { hooks: [canonicalHandler(command)] }];
  }
  return validateDocument(document);
};

const uninstallFromDocument = (
  original: JsonObject,
): { document: JsonObject; removed: number } => {
  const document = structuredClone(original);
  const hooks = hooksObject(document);
  let removed = 0;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const result = removeOwnedHandlers(value);
    removed += result.removed;
    if (result.groups.length === 0) delete hooks[event];
    else hooks[event] = result.groups;
  }
  return { document: validateDocument(document), removed };
};

const serialize = (document: JsonObject): string =>
  `${JSON.stringify(document, null, 2)}\n`;

const configPathFor = (projectRoot: string): string =>
  path.join(path.resolve(projectRoot), ".codex", "hooks.json");

const inspectDocument = (
  configPath: string,
  exists: boolean,
  document: JsonObject,
): CodexHookInstallationInspection => {
  const hooks = hooksObject(document);
  const events = Object.fromEntries(
    CODEX_HOOK_EVENTS.map((event) => {
      const groups = hooks[event];
      const installed =
        Array.isArray(groups) &&
        groups.some(
          (group) =>
            isObject(group) &&
            Array.isArray(group.hooks) &&
            group.hooks.some(isOwnedHandler),
        );
      return [event, installed];
    }),
  ) as Record<CodexHookEvent, boolean>;
  let ownedHandlerCount = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      ownedHandlerCount += group.hooks.filter(isOwnedHandler).length;
    }
  }
  const missingEvents = CODEX_HOOK_EVENTS.filter((event) => !events[event]);
  return {
    configPath,
    exists,
    installed: missingEvents.length === 0,
    events,
    ownedHandlerCount,
    missingEvents,
  };
};

const assertBraidProjectRoot = async (projectRoot: string): Promise<string> => {
  const root = await realpath(path.resolve(projectRoot));
  const git = await stat(path.join(root, ".git"));
  if (!git.isDirectory() && !git.isFile()) {
    throw new Error("Project root does not contain Git metadata.");
  }
  const config = await stat(path.join(root, ".braid", "architecture.yaml"));
  if (!config.isFile()) {
    throw new Error("Project root does not contain .braid/architecture.yaml.");
  }
  return root;
};

const fileExists = async (filePath: string): Promise<boolean> => {
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

const backupPathFor = (configPath: string, content: string): string => {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `${configPath}.braid-backup-${hash}`;
};

const atomicWrite = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const temporaryPath = `${filePath}.braid-tmp-${process.pid}`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
};

export const inspectCodexHookInstallation = async (
  projectRoot: string,
): Promise<CodexHookInstallationInspection> => {
  const configPath = configPathFor(projectRoot);
  const current = await readDocument(configPath);
  return inspectDocument(
    configPath,
    current.exists,
    structuredClone(current.document),
  );
};

export const installCodexHooks = async (
  options: InstallCodexHooksOptions,
): Promise<InstallCodexHooksResult> => {
  const capabilityProbe = await probeCodexHookCapabilities({
    ...(options.codexExecutable === undefined
      ? {}
      : { codexExecutable: options.codexExecutable }),
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });
  if (!capabilityProbe.supported) {
    throw new Error(
      `Codex hooks are not supported: ${capabilityProbe.reason ?? "unknown reason"}`,
    );
  }

  const projectRoot = await assertBraidProjectRoot(options.projectRoot);
  const dryRun = options.dryRun ?? false;
  if (!dryRun && options.confirm !== true) {
    throw new Error("Installing Codex hooks requires explicit confirmation.");
  }

  const configPath = configPathFor(projectRoot);
  const current = await readDocument(configPath);
  const desiredDocument = installIntoDocument(
    current.document,
    createCodexHookCommand(options.launcher),
  );
  const desired = serialize(desiredDocument);
  const changed = current.raw !== desired;
  const backupPath =
    changed && current.raw !== null
      ? backupPathFor(configPath, current.raw)
      : null;

  if (changed && !dryRun) {
    await mkdir(path.dirname(configPath), { recursive: true });
    if (
      current.raw !== null &&
      backupPath !== null &&
      !(await fileExists(backupPath))
    ) {
      await writeFile(backupPath, current.raw, "utf8");
    }
    await atomicWrite(configPath, desired);
    validateDocument(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  }

  const inspection = inspectDocument(
    configPath,
    current.exists || (!dryRun && changed),
    desiredDocument,
  );
  return {
    ...inspection,
    changed,
    dryRun,
    backupPath,
    capabilityProbe,
  };
};

export const uninstallCodexHooks = async (
  options: UninstallCodexHooksOptions,
): Promise<UninstallCodexHooksResult> => {
  const configPath = configPathFor(options.projectRoot);
  const current = await readDocument(configPath);
  const dryRun = options.dryRun ?? false;
  if (!current.exists) {
    return {
      ...inspectDocument(configPath, false, current.document),
      changed: false,
      dryRun,
      removedHandlerCount: 0,
    };
  }

  const result = uninstallFromDocument(current.document);
  const desired = serialize(result.document);
  const changed = result.removed > 0 && desired !== current.raw;
  if (changed && !dryRun) {
    await atomicWrite(configPath, desired);
    validateDocument(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  }
  return {
    ...inspectDocument(configPath, true, result.document),
    changed,
    dryRun,
    removedHandlerCount: result.removed,
  };
};
