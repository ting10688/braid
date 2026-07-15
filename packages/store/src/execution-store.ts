import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  migrationExecutionPlanSchema,
  migrationExecutionRecordSchema,
  projectRelativePathSchema,
  type MigrationExecutionPlan,
  type MigrationExecutionRecord,
  type MigrationExecutionStatus,
} from "@braid/core";
import {
  EXECUTIONS_DIRECTORY,
  PersistenceError,
  toPosixPath,
} from "@braid/shared";

export interface ExecutionStore {
  savePlan(executionId: string, plan: MigrationExecutionPlan): Promise<string>;
  loadPlan(executionId: string): Promise<MigrationExecutionPlan>;
  saveRecord(record: MigrationExecutionRecord): Promise<string>;
  loadRecord(executionId: string): Promise<MigrationExecutionRecord>;
  listRecords(): Promise<MigrationExecutionRecord[]>;
  recoverInterrupted(executionId?: string): Promise<MigrationExecutionRecord[]>;
  writeTextArtifact(
    executionId: string,
    relativePath: string,
    contents: string,
  ): Promise<string>;
  writeJsonArtifact(
    executionId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string>;
}

const executionIdPattern = /^E-[0-9a-f-]{36}$/u;
const reservedArtifacts = new Set(["plan.json", "record.json"]);

const allowedTransitions: Record<
  MigrationExecutionStatus,
  readonly MigrationExecutionStatus[]
> = {
  planned: ["preflight-failed", "worktree-created"],
  "preflight-failed": [],
  "worktree-created": ["running", "executor-failed", "discarded"],
  running: [
    "executor-failed",
    "no-changes",
    "scope-violation",
    "validation-failed",
    "needs-review",
    "succeeded",
    "discarded",
  ],
  "executor-failed": ["discarded"],
  "no-changes": ["discarded"],
  "scope-violation": ["discarded"],
  "validation-failed": ["discarded"],
  "needs-review": ["discarded"],
  succeeded: ["discarded"],
  discarded: [],
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
};

const serializeJson = (value: unknown): string => {
  const serialized = JSON.stringify(stableValue(value), null, 2);
  if (serialized === undefined)
    throw new PersistenceError("Portable JSON value is not serializable");
  return `${serialized}\n`;
};

const containsAbsolutePath = (value: string): boolean => {
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("file://")
  )
    return true;
  return value.split(/\s+/u).some((token) => {
    const candidate = token
      .replace(/^[('"[{<]+/u, "")
      .replace(/[)'"\]}>;,]+$/u, "");
    return (
      path.posix.isAbsolute(candidate) ||
      path.win32.isAbsolute(candidate) ||
      candidate.startsWith("file://")
    );
  });
};

const assertPortableJson = (
  value: unknown,
  location = "$",
  seen = new Set<unknown>(),
): void => {
  if (typeof value === "string" && containsAbsolutePath(value))
    throw new PersistenceError(
      `Portable JSON contains an absolute path at ${location}`,
    );
  if (value === null || typeof value !== "object") return;
  if (seen.has(value))
    throw new PersistenceError(`Portable JSON contains a cycle at ${location}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertPortableJson(item, `${location}[${index}]`, seen),
    );
  } else {
    Object.entries(value).forEach(([key, item]) => {
      if (containsAbsolutePath(key))
        throw new PersistenceError(
          `Portable JSON contains an absolute path at ${location}`,
        );
      assertPortableJson(item, `${location}.${key}`, seen);
    });
  }
  seen.delete(value);
};

const readText = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const writeImmutable = async (
  destination: string,
  contents: string,
  description: string,
): Promise<void> => {
  const existing = await readText(destination);
  if (existing !== null) {
    if (existing === contents) return;
    throw new PersistenceError(
      `${description} already contains different content`,
    );
  }

  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}-${randomUUID()}.tmp`,
  );
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const concurrent = await readText(destination);
      if (concurrent === contents) return;
      if (concurrent !== null)
        throw new PersistenceError(
          `${description} already contains different content`,
          { cause: error },
        );
    }
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(`Could not persist ${description}`, {
      cause: error,
    });
  } finally {
    await rm(temporary, { force: true });
  }
};

const writeReplacing = async (
  destination: string,
  contents: string,
  description: string,
): Promise<void> => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}-${randomUUID()}.tmp`,
  );
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    throw new PersistenceError(`Could not persist ${description}`, {
      cause: error,
    });
  } finally {
    await rm(temporary, { force: true });
  }
};

const withRecordLock = async <T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const lock = `${destination}.lock`;
  const deadline = Date.now() + 5_000;
  await mkdir(path.dirname(destination), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new PersistenceError("Could not acquire execution record lock", {
          cause: error,
        });
      try {
        const metadata = await stat(lock);
        if (Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT")
          throw new PersistenceError(
            "Could not inspect execution record lock",
            { cause: inspectionError },
          );
      }
      if (Date.now() >= deadline)
        throw new PersistenceError("Timed out acquiring execution record lock");
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

const assertExecutionId = (executionId: string): void => {
  if (!executionIdPattern.test(executionId))
    throw new PersistenceError(`Invalid execution ID: ${executionId}`);
};

const assertRecordIdentity = (
  previous: MigrationExecutionRecord,
  next: MigrationExecutionRecord,
): void => {
  if (
    previous.executionId !== next.executionId ||
    previous.planId !== next.planId ||
    previous.proposalId !== next.proposalId ||
    previous.baseCommit !== next.baseCommit ||
    previous.startedAt !== next.startedAt
  )
    throw new PersistenceError(
      `Execution record ${next.executionId} changed immutable identity`,
    );
};

const immutableRecordEvidence = (
  record: MigrationExecutionRecord,
): unknown => ({
  executor: {
    kind: record.executor.kind,
    model: record.executor.model,
    reasoningEffort: record.executor.reasoningEffort,
    sandbox: record.executor.sandbox,
  },
  allowedFiles: record.scope.allowedFiles,
  architecture: {
    beforeSnapshotId: record.architecture.beforeSnapshotId,
    predictedImpact: record.architecture.predictedImpact,
  },
  fingerprints: {
    mainBefore: record.fingerprints.mainBefore,
    candidateBefore: record.fingerprints.candidateBefore,
  },
});

const assertRecordEvidence = (
  previous: MigrationExecutionRecord,
  next: MigrationExecutionRecord,
): void => {
  if (
    serializeJson(immutableRecordEvidence(previous)) !==
      serializeJson(immutableRecordEvidence(next)) ||
    (previous.candidateBranch !== undefined &&
      previous.candidateBranch !== next.candidateBranch) ||
    (previous.candidateCommit !== undefined &&
      previous.candidateCommit !== next.candidateCommit)
  )
    throw new PersistenceError(
      `Execution record ${next.executionId} changed immutable evidence`,
    );
};

const assertRecordMatchesPlan = (
  record: MigrationExecutionRecord,
  plan: MigrationExecutionPlan,
): void => {
  const allowedFiles = [
    ...new Set([
      ...plan.scope.allowedExistingFiles,
      ...plan.scope.allowedTestFiles,
      ...plan.scope.allowedNewFilePatterns,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (
    record.planId !== plan.planId ||
    record.proposalId !== plan.proposalId ||
    record.baseCommit !== plan.repository.baseCommit ||
    record.executor.kind !== plan.executor.kind ||
    record.executor.model !== plan.executor.requestedModel ||
    record.executor.reasoningEffort !==
      plan.executor.requestedReasoningEffort ||
    serializeJson(record.scope.allowedFiles) !== serializeJson(allowedFiles) ||
    record.architecture.beforeSnapshotId !== plan.repository.snapshotId ||
    serializeJson(record.architecture.predictedImpact) !==
      serializeJson(plan.expectedChange.predictedImpact) ||
    record.fingerprints.candidateBefore !== plan.repository.sourceFingerprint
  )
    throw new PersistenceError(
      `Execution record ${record.executionId} does not match its immutable plan`,
    );
  if (record.status !== "succeeded") return;
  const expectedValidation = plan.validation.commands
    .map(({ id, stage, required }) => ({ commandId: id, stage, required }))
    .sort((left, right) => left.commandId.localeCompare(right.commandId));
  const actualValidation = record.validation
    .map(({ commandId, stage, required }) => ({
      commandId,
      stage,
      required,
    }))
    .sort((left, right) => left.commandId.localeCompare(right.commandId));
  if (serializeJson(actualValidation) !== serializeJson(expectedValidation))
    throw new PersistenceError(
      `Successful execution ${record.executionId} lacks complete plan validation evidence`,
    );
};

const assertTransition = (
  previous: MigrationExecutionRecord,
  next: MigrationExecutionRecord,
): void => {
  assertRecordIdentity(previous, next);
  if (previous.status === next.status)
    throw new PersistenceError(
      `Execution record ${next.executionId} already contains different content`,
    );
  if (!allowedTransitions[previous.status].includes(next.status))
    throw new PersistenceError(
      `Invalid execution status transition: ${previous.status} -> ${next.status}`,
    );
  assertRecordEvidence(previous, next);
};

export class JsonExecutionStore implements ExecutionStore {
  constructor(private readonly projectRoot: string) {}

  private executionDirectory(executionId: string): string {
    assertExecutionId(executionId);
    return path.join(this.projectRoot, EXECUTIONS_DIRECTORY, executionId);
  }

  private artifactDestination(
    executionId: string,
    relativePath: string,
  ): { absolute: string; portable: string } {
    const directory = this.executionDirectory(executionId);
    if (
      !projectRelativePathSchema.safeParse(relativePath).success ||
      reservedArtifacts.has(relativePath)
    )
      throw new PersistenceError(
        `Invalid execution artifact path: ${relativePath}`,
      );
    const absolute = path.resolve(directory, relativePath);
    const contained = path.relative(directory, absolute);
    if (contained.startsWith("..") || path.isAbsolute(contained))
      throw new PersistenceError(`Execution artifact escapes its directory`);
    return {
      absolute,
      portable: toPosixPath(
        path.join(EXECUTIONS_DIRECTORY, executionId, relativePath),
      ),
    };
  }

  async savePlan(
    executionId: string,
    planInput: MigrationExecutionPlan,
  ): Promise<string> {
    try {
      assertPortableJson(planInput);
      const plan = migrationExecutionPlanSchema.parse(planInput);
      assertPortableJson(plan);
      const destination = path.join(
        this.executionDirectory(executionId),
        "plan.json",
      );
      await writeImmutable(
        destination,
        serializeJson(plan),
        `execution plan ${plan.planId}`,
      );
      return destination;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Could not persist execution plan`, {
        cause: error,
      });
    }
  }

  async loadPlan(executionId: string): Promise<MigrationExecutionPlan> {
    try {
      const source = path.join(
        this.executionDirectory(executionId),
        "plan.json",
      );
      const raw: unknown = JSON.parse(await readFile(source, "utf8"));
      assertPortableJson(raw);
      const plan = migrationExecutionPlanSchema.parse(raw);
      assertPortableJson(plan);
      return plan;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        `Could not load execution plan for ${executionId}`,
        { cause: error },
      );
    }
  }

  async saveRecord(recordInput: MigrationExecutionRecord): Promise<string> {
    try {
      assertPortableJson(recordInput);
      const record = migrationExecutionRecordSchema.parse(recordInput);
      assertPortableJson(record);
      const plan = await this.loadPlan(record.executionId);
      assertRecordMatchesPlan(record, plan);
      const destination = path.join(
        this.executionDirectory(record.executionId),
        "record.json",
      );
      const contents = serializeJson(record);
      await withRecordLock(destination, async () => {
        const existingContents = await readText(destination);
        if (existingContents !== null) {
          if (existingContents === contents) return;
          const raw: unknown = JSON.parse(existingContents);
          assertPortableJson(raw);
          const existing = migrationExecutionRecordSchema.parse(raw);
          assertPortableJson(existing);
          assertTransition(existing, record);
        } else if (record.status !== "planned") {
          throw new PersistenceError(
            `Execution record ${record.executionId} must start as planned`,
          );
        }
        if (existingContents === null)
          await writeImmutable(
            destination,
            contents,
            `execution record ${record.executionId}`,
          );
        else
          await writeReplacing(
            destination,
            contents,
            `execution record ${record.executionId}`,
          );
      });
      return destination;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        `Could not persist execution record ${recordInput.executionId}`,
        { cause: error },
      );
    }
  }

  async loadRecord(executionId: string): Promise<MigrationExecutionRecord> {
    try {
      const source = path.join(
        this.executionDirectory(executionId),
        "record.json",
      );
      const raw: unknown = JSON.parse(await readFile(source, "utf8"));
      assertPortableJson(raw);
      const record = migrationExecutionRecordSchema.parse(raw);
      assertPortableJson(record);
      if (record.executionId !== executionId)
        throw new PersistenceError(
          `Execution record ID does not match directory ${executionId}`,
        );
      return record;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Could not load execution ${executionId}`, {
        cause: error,
      });
    }
  }

  async listRecords(): Promise<MigrationExecutionRecord[]> {
    const directory = path.join(this.projectRoot, EXECUTIONS_DIRECTORY);
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter(
          (entry) => entry.isDirectory() && executionIdPattern.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PersistenceError("Could not list migration executions", {
        cause: error,
      });
    }
    return Promise.all(names.map((name) => this.loadRecord(name)));
  }

  async recoverInterrupted(
    executionId?: string,
  ): Promise<MigrationExecutionRecord[]> {
    const records = executionId
      ? [await this.loadRecord(executionId)]
      : await this.listRecords();
    const recovered: MigrationExecutionRecord[] = [];
    for (const record of records) {
      if (record.status !== "running") continue;
      let candidateCommit: string | undefined;
      try {
        const locator: unknown = JSON.parse(
          await readFile(
            path.join(
              this.executionDirectory(record.executionId),
              "locator.local.json",
            ),
            "utf8",
          ),
        );
        if (
          locator !== null &&
          typeof locator === "object" &&
          "candidateCommit" in locator &&
          typeof locator.candidateCommit === "string" &&
          /^[a-f0-9]{40,64}$/u.test(locator.candidateCommit)
        )
          candidateCommit = locator.candidateCommit;
      } catch {
        // Candidate ownership is optional for an interrupted pre-commit run.
      }
      const next = migrationExecutionRecordSchema.parse({
        ...record,
        status: "executor-failed",
        completedAt: new Date().toISOString(),
        ...(candidateCommit ? { candidateCommit } : {}),
        failure: {
          stage: "executor",
          code: "interrupted-execution",
          message: "Execution was interrupted before completion",
        },
      });
      try {
        await this.saveRecord(next);
        recovered.push(next);
      } catch (error) {
        const current = await this.loadRecord(record.executionId);
        if (current.status === "running") throw error;
      }
    }
    return recovered;
  }

  async writeTextArtifact(
    executionId: string,
    relativePath: string,
    contents: string,
  ): Promise<string> {
    const destination = this.artifactDestination(executionId, relativePath);
    await writeImmutable(
      destination.absolute,
      contents,
      `execution artifact ${relativePath}`,
    );
    return destination.portable;
  }

  async writeJsonArtifact(
    executionId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string> {
    try {
      assertPortableJson(value);
      const destination = this.artifactDestination(executionId, relativePath);
      await writeImmutable(
        destination.absolute,
        serializeJson(value),
        `execution artifact ${relativePath}`,
      );
      return destination.portable;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        `Could not persist execution artifact ${relativePath}`,
        { cause: error },
      );
    }
  }
}
