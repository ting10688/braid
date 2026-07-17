import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { EXECUTIONS_DIRECTORY, MigrationSafetyError } from "@braid/shared";

export type ExecutionLockStatus = "unlocked" | "live" | "stale" | "ambiguous";

interface ExecutionLockOwner {
  schemaVersion: 1;
  executionId: string;
  repositoryId: string;
  host: string;
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface ExecutionLockInspection {
  status: ExecutionLockStatus;
  owner?: ExecutionLockOwner;
  message?: string;
}

export interface AcquiredExecutionLock {
  owner: ExecutionLockOwner;
  release(): Promise<void>;
}

const executionIdPattern = /^E-[0-9a-f-]{36}$/u;

const lockDirectory = (projectRoot: string, executionId: string): string => {
  if (!executionIdPattern.test(executionId))
    throw new MigrationSafetyError(
      `Invalid execution ID: ${executionId}`,
      12,
      "recovery-execution-id-invalid",
    );
  return path.join(
    projectRoot,
    EXECUTIONS_DIRECTORY,
    executionId,
    "recovery",
    "mutation.lock",
  );
};

const ownerPath = (directory: string): string =>
  path.join(directory, "owner.json");

const validOwner = (
  value: unknown,
  executionId: string,
  repositoryId: string,
): value is ExecutionLockOwner => {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<ExecutionLockOwner>;
  return (
    item.schemaVersion === 1 &&
    item.executionId === executionId &&
    item.repositoryId === repositoryId &&
    typeof item.host === "string" &&
    item.host.length > 0 &&
    Number.isSafeInteger(item.pid) &&
    (item.pid ?? 0) > 0 &&
    typeof item.token === "string" &&
    /^[0-9a-f-]{36}$/u.test(item.token) &&
    typeof item.acquiredAt === "string" &&
    !Number.isNaN(Date.parse(item.acquiredAt))
  );
};

const processIsAlive = (pid: number): "live" | "stale" | "ambiguous" => {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "stale";
    return "ambiguous";
  }
};

export const inspectExecutionLock = async (input: {
  projectRoot: string;
  executionId: string;
  repositoryId: string;
}): Promise<ExecutionLockInspection> => {
  const directory = lockDirectory(input.projectRoot, input.executionId);
  let raw: string;
  try {
    raw = await readFile(ownerPath(directory), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        await readFile(directory, "utf8");
      } catch (directoryError) {
        if ((directoryError as NodeJS.ErrnoException).code === "ENOENT")
          return { status: "unlocked" };
      }
      return {
        status: "ambiguous",
        message: "Execution lock exists without readable owner evidence",
      };
    }
    return {
      status: "ambiguous",
      message: "Execution lock owner evidence could not be read",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "ambiguous",
      message: "Execution lock owner evidence is invalid JSON",
    };
  }
  if (!validOwner(parsed, input.executionId, input.repositoryId))
    return {
      status: "ambiguous",
      message: "Execution lock owner evidence does not match the execution",
    };
  if (parsed.host !== hostname())
    return {
      status: "ambiguous",
      owner: parsed,
      message: "Execution lock belongs to another host",
    };
  const status = processIsAlive(parsed.pid);
  return {
    status,
    owner: parsed,
    ...(status === "ambiguous"
      ? { message: "Execution lock process liveness is ambiguous" }
      : {}),
  };
};

const writeOwner = async (
  directory: string,
  owner: ExecutionLockOwner,
): Promise<void> => {
  const temporary = path.join(directory, `.owner-${owner.token}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, ownerPath(directory));
  } finally {
    await rm(temporary, { force: true });
  }
};

export const acquireExecutionLock = async (input: {
  projectRoot: string;
  executionId: string;
  repositoryId: string;
  now?: () => Date;
}): Promise<AcquiredExecutionLock> => {
  const directory = lockDirectory(input.projectRoot, input.executionId);
  const create = async (): Promise<ExecutionLockOwner | null> => {
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(path.dirname(directory), { recursive: true });
        try {
          await mkdir(directory);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === "EEXIST")
            return null;
          throw retryError;
        }
      } else if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return null;
      } else {
        throw error;
      }
    }
    const owner: ExecutionLockOwner = {
      schemaVersion: 1,
      executionId: input.executionId,
      repositoryId: input.repositoryId,
      host: hostname(),
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: (input.now?.() ?? new Date()).toISOString(),
    };
    try {
      await writeOwner(directory, owner);
      return owner;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };

  let owner = await create();
  if (!owner) {
    const inspection = await inspectExecutionLock(input);
    if (inspection.status === "stale" && inspection.owner) {
      const current = await readFile(ownerPath(directory), "utf8").catch(
        () => "",
      );
      if (`${JSON.stringify(inspection.owner, null, 2)}\n` !== current)
        throw new MigrationSafetyError(
          "Execution lock changed during stale-lock verification",
          12,
          "recovery-lock-ambiguous",
        );
      await rm(directory, { recursive: true });
      owner = await create();
    }
    if (!owner)
      throw new MigrationSafetyError(
        inspection.message ??
          (inspection.status === "live"
            ? "Another process owns this migration execution"
            : "Execution lock cannot be safely reclaimed"),
        12,
        inspection.status === "live"
          ? "recovery-lock-conflict"
          : "recovery-lock-ambiguous",
      );
  }

  return {
    owner,
    async release() {
      const current = await readFile(ownerPath(directory), "utf8").catch(
        () => "",
      );
      if (`${JSON.stringify(owner, null, 2)}\n` !== current)
        throw new MigrationSafetyError(
          "Execution lock ownership changed before release",
          12,
          "recovery-lock-ambiguous",
        );
      await rm(directory, { recursive: true });
    },
  };
};
