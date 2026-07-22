import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_TIMEOUT_SECONDS,
  probeClaudeHookCapabilities,
  type ClaudeHookCapabilityProbe,
} from "./capabilities.js";
import type { CommandRunner } from "../codex/capabilities.js";

const execFileAsync = promisify(execFile);

export const BRAID_CLAUDE_HOOK_OWNER = "@braid/guard@0.1.0" as const;
export const BRAID_CLAUDE_HOOK_STATUS =
  `Braid Growth Mode manual adapter (${BRAID_CLAUDE_HOOK_OWNER})` as const;

type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
type JsonObject = Record<string, unknown>;

interface HookDocumentRead {
  document: JsonObject;
  exists: boolean;
  raw: string | null;
}

export interface ClaudeHookInstallationInspection {
  configPath: string;
  exists: boolean;
  installed: boolean;
  events: Record<ClaudeHookEvent, boolean>;
  ownedHandlerCount: number;
  missingEvents: ClaudeHookEvent[];
}

export interface InstallClaudeHooksOptions {
  projectRoot: string;
  launcher: string[];
  dryRun?: boolean;
  confirm?: boolean;
  claudeExecutable?: string;
  runCommand?: CommandRunner;
  renameFile?: typeof rename;
}

export interface InstallClaudeHooksResult extends ClaudeHookInstallationInspection {
  changed: boolean;
  dryRun: boolean;
  backupPath: string | null;
  capabilityProbe: ClaudeHookCapabilityProbe;
  diff: string;
}

export interface UninstallClaudeHooksOptions {
  projectRoot: string;
  dryRun?: boolean;
  renameFile?: typeof rename;
}

export interface UninstallClaudeHooksResult extends ClaudeHookInstallationInspection {
  changed: boolean;
  dryRun: boolean;
  removedHandlerCount: number;
  diff: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const hooksObject = (document: JsonObject, create: boolean): JsonObject => {
  const hooks = document.hooks;
  if (hooks === undefined) {
    if (!create) return {};
    const created: JsonObject = {};
    document.hooks = created;
    return created;
  }
  if (!isObject(hooks)) {
    throw new Error("Claude settings `hooks` must be an object.");
  }
  return hooks;
};

const quotePosix = (argument: string): string =>
  `'${argument.replaceAll("'", `'"'"'`)}'`;

export const createClaudeHookCommand = (
  launcher: readonly string[],
): string => {
  if (launcher.length === 0 || launcher.some((part) => part.length === 0)) {
    throw new Error("Claude hook launcher must contain non-empty arguments.");
  }
  return [
    `BRAID_GROWTH_HOOK_OWNER=${quotePosix(BRAID_CLAUDE_HOOK_OWNER)}`,
    `BRAID_CLAUDE_HOOK_SOURCE=${quotePosix("manual")}`,
    ...launcher.map(quotePosix),
    quotePosix("--host"),
    quotePosix("claude"),
    quotePosix("--source"),
    quotePosix("manual"),
  ].join(" ");
};

const hasOwnershipSignal = (value: JsonObject): boolean =>
  (typeof value.command === "string" &&
    value.command.includes("BRAID_GROWTH_HOOK_OWNER=")) ||
  value.statusMessage === BRAID_CLAUDE_HOOK_STATUS;

const isOwnedHandler = (value: unknown): boolean =>
  isObject(value) &&
  value.type === "command" &&
  typeof value.command === "string" &&
  value.command.includes(BRAID_CLAUDE_HOOK_OWNER) &&
  value.command.includes("BRAID_CLAUDE_HOOK_SOURCE=") &&
  value.command.includes("manual") &&
  value.statusMessage === BRAID_CLAUDE_HOOK_STATUS;

const assertUnambiguousHandler = (value: unknown): void => {
  if (isObject(value) && hasOwnershipSignal(value) && !isOwnedHandler(value)) {
    throw new Error(
      "Claude settings contain ambiguous Braid hook ownership; refusing to modify them.",
    );
  }
};

const validateDocument = (value: unknown): JsonObject => {
  if (!isObject(value))
    throw new Error("Claude settings must be a JSON object.");
  const hooks = hooksObject(value, false);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Claude hook event ${event} must contain an array.`);
    }
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        throw new Error(
          `Claude hook event ${event} contains an invalid matcher group.`,
        );
      }
      for (const handler of group.hooks) {
        if (!isObject(handler)) {
          throw new Error(
            `Claude hook event ${event} contains an invalid handler.`,
          );
        }
        assertUnambiguousHandler(handler);
      }
    }
  }
  return value;
};

const readDocument = async (configPath: string): Promise<HookDocumentRead> => {
  try {
    const metadata = await lstat(configPath);
    if (metadata.isSymbolicLink()) {
      throw new Error("Claude settings file must not be a symbolic link.");
    }
    if (!metadata.isFile())
      throw new Error("Claude settings path is not a file.");
    const raw = await readFile(configPath, "utf8");
    return {
      document: validateDocument(JSON.parse(raw) as unknown),
      exists: true,
      raw,
    };
  } catch (error) {
    if (isMissing(error)) return { document: {}, exists: false, raw: null };
    throw error;
  }
};

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
    const retainedHandlers = group.hooks.filter((handler) => {
      assertUnambiguousHandler(handler);
      if (!isOwnedHandler(handler)) return true;
      removed += 1;
      return false;
    });
    if (retainedHandlers.length > 0) {
      retainedGroups.push({ ...group, hooks: retainedHandlers });
    }
  }
  return { groups: retainedGroups, removed };
};

const canonicalHandler = (command: string): JsonObject => ({
  type: "command",
  command,
  statusMessage: BRAID_CLAUDE_HOOK_STATUS,
  timeout: CLAUDE_HOOK_TIMEOUT_SECONDS,
});

const installIntoDocument = (
  original: JsonObject,
  command: string,
): JsonObject => {
  const document = structuredClone(original);
  const hooks = hooksObject(document, true);
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) {
      throw new Error(`Claude hook event ${event} must contain an array.`);
    }
    const retained = removeOwnedHandlers(groups).groups;
    hooks[event] = [
      ...retained,
      {
        ...(event === "PostToolUse"
          ? { matcher: "Write|Edit|MultiEdit|NotebookEdit" }
          : {}),
        hooks: [canonicalHandler(command)],
      },
    ];
  }
  return validateDocument(document);
};

const uninstallFromDocument = (
  original: JsonObject,
): { document: JsonObject; removed: number } => {
  const document = structuredClone(original);
  const hooks = hooksObject(document, false);
  let removed = 0;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const result = removeOwnedHandlers(value);
    removed += result.removed;
    if (result.groups.length === 0) delete hooks[event];
    else hooks[event] = result.groups;
  }
  if (Object.keys(hooks).length === 0) delete document.hooks;
  return { document: validateDocument(document), removed };
};

const serialize = (document: JsonObject): string =>
  `${JSON.stringify(document, null, 2)}\n`;

const diffFor = (before: string | null, after: string | null): string =>
  [
    "--- before",
    before ?? "<absent>\n",
    "+++ after",
    after ?? "<absent>\n",
  ].join("\n");

const resolveClaudeConfigPath = async (
  projectRoot: string,
): Promise<string> => {
  const root = await realpath(path.resolve(projectRoot));
  const config = await stat(path.join(root, ".braid", "architecture.yaml"));
  if (!config.isFile()) {
    throw new Error("Project root does not contain .braid/architecture.yaml.");
  }
  const result = await execFileAsync(
    "git",
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  const commonDirectory = await realpath(result.stdout.trim());
  const mainRoot = path.dirname(commonDirectory);
  const claudeDirectory = path.join(mainRoot, ".claude");
  try {
    const metadata = await lstat(claudeDirectory);
    if (metadata.isSymbolicLink()) {
      throw new Error("Claude settings directory must not be a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Claude settings parent is not a directory.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return path.join(claudeDirectory, "settings.local.json");
};

const inspectDocument = (
  configPath: string,
  exists: boolean,
  document: JsonObject,
): ClaudeHookInstallationInspection => {
  const hooks = hooksObject(document, false);
  const events = Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((event) => {
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
  ) as Record<ClaudeHookEvent, boolean>;
  let ownedHandlerCount = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        assertUnambiguousHandler(handler);
        if (isOwnedHandler(handler)) ownedHandlerCount += 1;
      }
    }
  }
  const missingEvents = CLAUDE_HOOK_EVENTS.filter((event) => !events[event]);
  return {
    configPath,
    exists,
    installed: missingEvents.length === 0,
    events,
    ownedHandlerCount,
    missingEvents,
  };
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
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
  renameFile: typeof rename = rename,
): Promise<void> => {
  const temporaryPath = `${filePath}.braid-tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await renameFile(temporaryPath, filePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original atomic-write failure; the temp path remains owned.
    }
    throw error;
  }
};

export const inspectClaudeHookInstallation = async (
  projectRoot: string,
): Promise<ClaudeHookInstallationInspection> => {
  const configPath = await resolveClaudeConfigPath(projectRoot);
  const current = await readDocument(configPath);
  return inspectDocument(configPath, current.exists, current.document);
};

export const installClaudeHooks = async (
  options: InstallClaudeHooksOptions,
): Promise<InstallClaudeHooksResult> => {
  const capabilityProbe = await probeClaudeHookCapabilities({
    ...(options.claudeExecutable === undefined
      ? {}
      : { claudeExecutable: options.claudeExecutable }),
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });
  if (!capabilityProbe.supported) {
    throw new Error(
      `Claude hooks are not supported: ${capabilityProbe.reason ?? "unknown reason"}`,
    );
  }
  const dryRun = options.dryRun ?? false;
  if (!dryRun && options.confirm !== true) {
    throw new Error("Installing Claude hooks requires explicit confirmation.");
  }

  const configPath = await resolveClaudeConfigPath(options.projectRoot);
  const current = await readDocument(configPath);
  const desiredDocument = installIntoDocument(
    current.document,
    createClaudeHookCommand(options.launcher),
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
      await writeFile(backupPath, current.raw, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await atomicWrite(configPath, desired, options.renameFile);
    validateDocument(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  }
  return {
    ...inspectDocument(
      configPath,
      current.exists || (!dryRun && changed),
      desiredDocument,
    ),
    changed,
    dryRun,
    backupPath,
    capabilityProbe,
    diff: diffFor(current.raw, desired),
  };
};

export const uninstallClaudeHooks = async (
  options: UninstallClaudeHooksOptions,
): Promise<UninstallClaudeHooksResult> => {
  const configPath = await resolveClaudeConfigPath(options.projectRoot);
  const current = await readDocument(configPath);
  const dryRun = options.dryRun ?? false;
  if (!current.exists) {
    return {
      ...inspectDocument(configPath, false, current.document),
      changed: false,
      dryRun,
      removedHandlerCount: 0,
      diff: diffFor(null, null),
    };
  }
  const result = uninstallFromDocument(current.document);
  const removeFile = Object.keys(result.document).length === 0;
  const desired = removeFile ? null : serialize(result.document);
  const changed = result.removed > 0 && desired !== current.raw;
  if (changed && !dryRun) {
    if (removeFile) await unlink(configPath);
    else if (desired !== null)
      await atomicWrite(configPath, desired, options.renameFile);
  }
  return {
    ...inspectDocument(
      configPath,
      current.exists && (dryRun || !removeFile || !changed),
      result.document,
    ),
    changed,
    dryRun,
    removedHandlerCount: result.removed,
    diff: diffFor(current.raw, desired),
  };
};
