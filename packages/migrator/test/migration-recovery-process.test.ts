import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JsonProposalStore, JsonSnapshotStore } from "@braid/store";
import {
  defaultExecutionRoot,
  durableExecutorStagingPath,
} from "../src/index.js";
import {
  createMigrationFixture,
  git,
  type MigrationFixture,
} from "../src/testing/notification-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
let bundleDirectory = "";
let cliBundle = "";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const waitForExit = async (
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

interface RunningChild {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
}

const startCli = (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): RunningChild => {
  const child = spawn(process.execPath, [cliBundle, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.once("close", () => liveChildren.delete(child));
  child.stdin.end();
  return { child, stdout: () => stdout, stderr: () => stderr };
};

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliResult> => {
  const running = startCli(arguments_, environment);
  const timer = setTimeout(() => running.child.kill("SIGKILL"), 45_000);
  try {
    const result = await waitForExit(running.child);
    return {
      ...result,
      stdout: running.stdout(),
      stderr: running.stderr(),
    };
  } finally {
    clearTimeout(timer);
  }
};

const expectSuccessfulCli = (result: CliResult): void => {
  expect(result, result.stderr || result.stdout).toMatchObject({
    code: 0,
    signal: null,
  });
};

const waitForMarker = async (
  marker: string,
  running: RunningChild,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!(await exists(marker))) {
    if (running.child.exitCode !== null || running.child.signalCode !== null)
      throw new Error(
        `Braid exited before crash marker: ${running.stderr() || running.stdout()}`,
      );
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for crash marker: ${running.stderr() || running.stdout()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const parseJson = <T>(result: CliResult): T => {
  expectSuccessfulCli(result);
  return JSON.parse(result.stdout) as T;
};

const fakeOrderService = `import { sendOrderNotification } from "../notification/notification-service.ts";

export {
  notificationLog,
  resetNotifications,
  sendOrderNotification,
  sentNotifications,
} from "../notification/notification-service.ts";
export type { SentNotification } from "../notification/notification-service.ts";

export interface Order {
  id: string;
  customerEmail: string;
  totalCents: number;
  status: "placed";
}

export const placeOrder = (
  id: string,
  customerEmail: string,
  totalCents: number,
): Order => {
  if (totalCents <= 0) throw new RangeError("Order total must be positive");
  const order: Order = {
    id,
    customerEmail,
    totalCents,
    status: "placed",
  };
  sendOrderNotification(id, customerEmail, "order placed");
  return order;
};
`;

const fakeNotificationService = `export interface SentNotification {
  orderId: string;
  recipient: string;
  message: string;
}

export const notificationLog: string[] = [];
export const sentNotifications: SentNotification[] = [];

export const sendOrderNotification = (
  orderId: string,
  recipient: string,
  message: string,
): SentNotification => {
  const notification = { orderId, recipient, message };
  sentNotifications.push(notification);
  notificationLog.push(\`\${orderId}:\${message}\`);
  return notification;
};

export const resetNotifications = (): void => {
  notificationLog.length = 0;
  sentNotifications.length = 0;
};
`;

const fakeCodexProgram = (): string => `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.recovery-test.0\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("--ask-for-approval <POLICY>\\n--cd <DIR>\\n");
  process.exit(0);
}

const counterPath = process.env.BRAID_FAKE_CODEX_COUNTER;
if (!counterPath) throw new Error("BRAID_FAKE_CODEX_COUNTER is required");
let launches = 0;
try { launches = Number(readFileSync(counterPath, "utf8")); } catch {}
writeFileSync(counterPath, String(launches + 1));

const hangPidPath = process.env.BRAID_FAKE_CODEX_HANG_PID;
if (hangPidPath) {
  writeFileSync(hangPidPath, String(process.pid));
  setInterval(() => undefined, 1000);
}

const cdIndex = process.argv.indexOf("--cd");
if (cdIndex < 0 || !process.argv[cdIndex + 1])
  throw new Error("The fake Codex process requires --cd");
const target = process.argv[cdIndex + 1];
mkdirSync(path.join(target, "src", "notification"), { recursive: true });
writeFileSync(
  path.join(target, "src", "notification", "notification-service.ts"),
  ${JSON.stringify(fakeNotificationService)},
);
writeFileSync(
  path.join(target, "src", "orders", "order-service.ts"),
  ${JSON.stringify(fakeOrderService)},
);

const summary = {
  status: "completed",
  changedFiles: [
    "src/notification/notification-service.ts",
    "src/orders/order-service.ts",
  ],
  addedFiles: ["src/notification/notification-service.ts"],
  testsRun: [],
  summary: "Applied the deterministic recovery fixture extraction.",
  unresolvedConcerns: [],
};
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: JSON.stringify(summary) },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
}) + "\\n");
`;

const createFixture = async (): Promise<{
  item: MigrationFixture;
  environment: NodeJS.ProcessEnv;
  counterPath: string;
}> => {
  const container = await mkdtemp(
    path.join(tmpdir(), "braid-recovery-process-"),
  );
  temporaryDirectories.push(container);
  const item = await createMigrationFixture(container);
  await Promise.all([
    new JsonSnapshotStore(item.repositoryRoot).save(item.snapshot),
    new JsonProposalStore(item.repositoryRoot).save(item.proposal),
  ]);
  const bin = path.join(container, "bin");
  const executable = path.join(bin, "codex");
  const counterPath = path.join(container, "executor-launches");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, fakeCodexProgram(), { mode: 0o755 });
  await chmod(executable, 0o755);
  return {
    item,
    counterPath,
    environment: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      BRAID_FAKE_CODEX_COUNTER: counterPath,
    },
  };
};

const executorLaunches = async (counterPath: string): Promise<number> => {
  try {
    return Number(await readFile(counterPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const killDetachedTestProcess = (pid: number): void => {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

const onlyExecutionId = async (item: MigrationFixture): Promise<string> => {
  const executionDirectories = (
    await readdir(path.join(item.repositoryRoot, ".braid", "executions"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("E-"))
    .map(({ name }) => name)
    .sort();
  expect(executionDirectories).toHaveLength(1);
  return executionDirectories[0]!;
};

const externallyObservedCheckpoint = async (
  item: MigrationFixture,
  executionId: string,
): Promise<string> => {
  const entriesDirectory = path.join(
    item.repositoryRoot,
    ".braid",
    "executions",
    executionId,
    "recovery",
    "entries",
  );
  const entries = (await readdir(entriesDirectory))
    .filter((name) => /^\d{6}-[a-z-]+\.json$/u.test(name))
    .sort();
  expect(entries.length).toBeGreaterThan(0);
  const latest = JSON.parse(
    await readFile(path.join(entriesDirectory, entries.at(-1)!), "utf8"),
  ) as { checkpoint: string };
  return latest.checkpoint;
};

interface RecoveryReport {
  executionId: string;
  classification:
    | "resumable"
    | "cleanup-required"
    | "already-complete"
    | "unsafe-to-resume"
    | "manual-inspection-required";
  latestCheckpoint: string | null;
  executorLaunchPermitted: boolean;
  candidateCreationPermitted: boolean;
  cleanupEligible: boolean;
  integrity: { valid: boolean; code?: string };
}

interface ExecutionRecord {
  executionId: string;
  status: string;
  baseCommit: string;
  candidateCommit?: string;
  scope: {
    changedFiles: string[];
    addedFiles: string[];
    deletedFiles: string[];
    violations: unknown[];
  };
  fingerprints: { mainBefore: string; mainAfter?: string };
}

type RecoveryAction = "resume" | "cleanup" | "none";

interface CrashCase {
  event: string;
  latestCheckpoint: string;
  classification: RecoveryReport["classification"];
  action: RecoveryAction;
  launchesBefore: number;
  launchesAfter: number;
}

const crashCases: CrashCase[] = [
  {
    event: "planned",
    latestCheckpoint: "planned",
    classification: "resumable",
    action: "resume",
    launchesBefore: 0,
    launchesAfter: 1,
  },
  {
    event: "preflight-passed",
    latestCheckpoint: "preflight-passed",
    classification: "resumable",
    action: "resume",
    launchesBefore: 0,
    launchesAfter: 1,
  },
  {
    event: "staging-created",
    latestCheckpoint: "staging-created",
    classification: "resumable",
    action: "resume",
    launchesBefore: 0,
    launchesAfter: 1,
  },
  {
    event: "executor-started",
    latestCheckpoint: "executor-started",
    classification: "unsafe-to-resume",
    action: "cleanup",
    launchesBefore: 0,
    launchesAfter: 0,
  },
  {
    event: "executor-finished",
    latestCheckpoint: "executor-finished",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "patch-captured",
    latestCheckpoint: "patch-captured",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "scope-verified",
    latestCheckpoint: "scope-verified",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "validation-passed",
    latestCheckpoint: "validation-passed",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "architecture-passed",
    latestCheckpoint: "architecture-passed",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "candidate-prepared",
    latestCheckpoint: "candidate-prepared",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "candidate-object-created",
    latestCheckpoint: "candidate-prepared",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "candidate-ref-updated",
    latestCheckpoint: "candidate-prepared",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "candidate-created",
    latestCheckpoint: "candidate-created",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "execution-record-written-before-completed",
    latestCheckpoint: "candidate-created",
    classification: "resumable",
    action: "resume",
    launchesBefore: 1,
    launchesAfter: 0,
  },
  {
    event: "completed",
    latestCheckpoint: "completed",
    classification: "already-complete",
    action: "none",
    launchesBefore: 1,
    launchesAfter: 0,
  },
];

beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(tmpdir(), "braid-recovery-cli-"));
  cliBundle = path.join(bundleDirectory, "braid.mjs");
  const source = (relative: string): string =>
    path.join(repositoryRoot, relative);
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [source("apps/cli/src/index.ts")],
    outfile: cliBundle,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    legalComments: "none",
    logLevel: "silent",
    alias: {
      "@braid/analyzer": source("packages/analyzer/src/index.ts"),
      "@braid/benchmark": source("packages/benchmark/src/index.ts"),
      "@braid/core": source("packages/core/src/index.ts"),
      "@braid/guard": source("packages/guard/src/index.ts"),
      "@braid/migrator": source("packages/migrator/src/index.ts"),
      "@braid/planner": source("packages/planner/src/index.ts"),
      "@braid/shared": source("packages/shared/src/index.ts"),
      "@braid/store": source("packages/store/src/index.ts"),
    },
    banner: {
      js:
        'import { createRequire as __createRequire } from "node:module"; ' +
        'import { fileURLToPath as __fileURLToPath } from "node:url"; ' +
        'import { dirname as __pathDirname } from "node:path"; ' +
        "const require = __createRequire(import.meta.url); " +
        "const __filename = __fileURLToPath(import.meta.url); " +
        "const __dirname = __pathDirname(__filename);",
    },
  });
}, 30_000);

afterEach(async () => {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (bundleDirectory)
    await rm(bundleDirectory, { recursive: true, force: true });
});

describe("durable migration process recovery matrix", () => {
  it.each(crashCases)(
    "recovers a separate CLI process interrupted after $event",
    async (testCase) => {
      const { item, environment, counterPath } = await createFixture();
      const marker = path.join(item.container, `paused-${testCase.event}`);
      const mainHeadBefore = await git(item.repositoryRoot, [
        "rev-parse",
        "HEAD",
      ]);
      const crashingEnvironment = {
        ...environment,
        NODE_ENV: "test",
        BRAID_INTERNAL_TEST_PAUSE_AFTER_RECOVERY_EVENT: testCase.event,
        BRAID_INTERNAL_TEST_PAUSE_MARKER: marker,
      };
      const running = startCli(
        [
          "migrate",
          "run",
          item.proposal.id,
          "--path",
          item.repositoryRoot,
          "--approve",
          item.proposal.id,
          "--json",
        ],
        crashingEnvironment,
      );
      const crashed = waitForExit(running.child);
      let executionId = "";
      try {
        await waitForMarker(marker, running);
        executionId = await onlyExecutionId(item);
        expect(await externallyObservedCheckpoint(item, executionId)).toBe(
          testCase.latestCheckpoint,
        );
        if (
          testCase.event === "candidate-object-created" ||
          testCase.event === "candidate-ref-updated"
        ) {
          const preparation = JSON.parse(
            await readFile(
              path.join(
                item.repositoryRoot,
                ".braid",
                "executions",
                executionId,
                "recovery",
                "candidate-preparation.json",
              ),
              "utf8",
            ),
          ) as { expectedCommit: string; ref: string };
          await expect(
            git(item.repositoryRoot, [
              "cat-file",
              "-e",
              `${preparation.expectedCommit}^{commit}`,
            ]),
          ).resolves.toBe("");
          if (testCase.event === "candidate-ref-updated")
            await expect(
              git(item.repositoryRoot, ["rev-parse", preparation.ref]),
            ).resolves.toBe(preparation.expectedCommit);
        }
        if (testCase.event === "execution-record-written-before-completed") {
          const durableRecord = JSON.parse(
            await readFile(
              path.join(
                item.repositoryRoot,
                ".braid",
                "executions",
                executionId,
                "record.json",
              ),
              "utf8",
            ),
          ) as ExecutionRecord;
          expect(durableRecord.status).toBe("succeeded");
        }
      } finally {
        running.child.kill("SIGKILL");
      }
      const killed = await crashed;
      expect(killed.signal).toBe("SIGKILL");
      expect(executionId).not.toBe("");
      const launchesBefore = await executorLaunches(counterPath);
      expect(launchesBefore).toBe(testCase.launchesBefore);

      const recovery = parseJson<RecoveryReport>(
        await runCli(
          [
            "migrate",
            "recover",
            executionId,
            "--path",
            item.repositoryRoot,
            "--json",
          ],
          environment,
        ),
      );
      expect(recovery).toMatchObject({
        executionId,
        classification: testCase.classification,
        latestCheckpoint: testCase.latestCheckpoint,
        integrity: { valid: true },
      });
      expect(recovery.executorLaunchPermitted).toBe(
        testCase.classification === "resumable" &&
          ["planned", "preflight-passed", "staging-created"].includes(
            testCase.latestCheckpoint,
          ),
      );
      expect(recovery.candidateCreationPermitted).toBe(
        testCase.classification === "resumable" &&
          testCase.latestCheckpoint === "candidate-prepared",
      );

      let record: ExecutionRecord;
      if (testCase.action === "resume") {
        expect(recovery.cleanupEligible).toBe(false);
        record = parseJson<ExecutionRecord>(
          await runCli(
            [
              "migrate",
              "resume",
              executionId,
              "--path",
              item.repositoryRoot,
              "--confirm",
              executionId,
              "--json",
            ],
            environment,
          ),
        );
      } else if (testCase.action === "cleanup") {
        expect(recovery).toMatchObject({
          executorLaunchPermitted: false,
          candidateCreationPermitted: false,
          cleanupEligible: true,
        });
        expectSuccessfulCli(
          await runCli(
            [
              "migrate",
              "cleanup",
              executionId,
              "--path",
              item.repositoryRoot,
              "--confirm",
              executionId,
              "--json",
            ],
            environment,
          ),
        );
        record = JSON.parse(
          await readFile(
            path.join(
              item.repositoryRoot,
              ".braid",
              "executions",
              executionId,
              "record.json",
            ),
            "utf8",
          ),
        ) as ExecutionRecord;
      } else {
        record = JSON.parse(
          await readFile(
            path.join(
              item.repositoryRoot,
              ".braid",
              "executions",
              executionId,
              "record.json",
            ),
            "utf8",
          ),
        ) as ExecutionRecord;
      }

      const launchesAfter =
        (await executorLaunches(counterPath)) - launchesBefore;
      expect(launchesAfter).toBe(testCase.launchesAfter);
      expect(await executorLaunches(counterPath)).toBe(
        testCase.launchesBefore + testCase.launchesAfter,
      );

      const candidateCommits = (
        await git(item.repositoryRoot, [
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/braid/exec/",
        ])
      )
        .split("\n")
        .filter(Boolean);
      const executionRoot = defaultExecutionRoot(item.repositoryRoot);
      const candidateWorktree = path.join(executionRoot, executionId);
      const staging = durableExecutorStagingPath(executionRoot, executionId);
      const recoveryDirectory = path.join(
        item.repositoryRoot,
        ".braid",
        "executions",
        executionId,
        "recovery",
      );

      if (testCase.action === "cleanup") {
        expect(record.status).toBe("discarded");
        expect(record.candidateCommit).toBeUndefined();
        expect(candidateCommits).toEqual([]);
        expect(await exists(candidateWorktree)).toBe(false);
        expect(await exists(staging)).toBe(false);
        const terminal = parseJson<RecoveryReport>(
          await runCli(
            [
              "migrate",
              "recover",
              executionId,
              "--path",
              item.repositoryRoot,
              "--json",
            ],
            environment,
          ),
        );
        expect(terminal.latestCheckpoint).toBe("discarded");
      } else {
        expect(record).toMatchObject({
          executionId,
          status: "succeeded",
          baseCommit: item.baseCommit,
          scope: {
            changedFiles: [
              "src/notification/notification-service.ts",
              "src/orders/order-service.ts",
            ],
            addedFiles: ["src/notification/notification-service.ts"],
            deletedFiles: [],
            violations: [],
          },
        });
        expect(record.candidateCommit).toMatch(/^[a-f0-9]{40,64}$/u);
        const preparation = JSON.parse(
          await readFile(
            path.join(recoveryDirectory, "candidate-preparation.json"),
            "utf8",
          ),
        ) as { expectedCommit: string };
        expect(record.candidateCommit).toBe(preparation.expectedCommit);
        expect(candidateCommits).toEqual([record.candidateCommit]);
        expect(
          await git(item.repositoryRoot, [
            "rev-list",
            "--count",
            `${item.baseCommit}..${record.candidateCommit!}`,
          ]),
        ).toBe("1");
        expect(await exists(candidateWorktree)).toBe(true);
        expect(await exists(staging)).toBe(false);
        const terminal = parseJson<RecoveryReport>(
          await runCli(
            [
              "migrate",
              "recover",
              executionId,
              "--path",
              item.repositoryRoot,
              "--json",
            ],
            environment,
          ),
        );
        expect(terminal).toMatchObject({
          latestCheckpoint: "completed",
          classification: "already-complete",
          integrity: { valid: true },
          executorLaunchPermitted: false,
          candidateCreationPermitted: false,
          cleanupEligible: false,
        });
      }

      expect(
        await exists(path.join(recoveryDirectory, "executor-process.json")),
      ).toBe(false);
      expect(
        await exists(path.join(recoveryDirectory, "candidate-index")),
      ).toBe(false);
      expect(await git(item.repositoryRoot, ["rev-parse", "HEAD"])).toBe(
        mainHeadBefore,
      );
      expect(await git(item.repositoryRoot, ["status", "--porcelain=v1"])).toBe(
        "",
      );
      expect(record.fingerprints.mainAfter).toBe(
        record.fingerprints.mainBefore,
      );
    },
    60_000,
  );

  it("refuses cleanup after the Braid parent is killed during a detached executor launch", async () => {
    const { item, environment, counterPath } = await createFixture();
    const executorPidPath = path.join(item.container, "hanging-executor-pid");
    const mainHeadBefore = await git(item.repositoryRoot, [
      "rev-parse",
      "HEAD",
    ]);
    const running = startCli(
      [
        "migrate",
        "run",
        item.proposal.id,
        "--path",
        item.repositoryRoot,
        "--approve",
        item.proposal.id,
        "--json",
      ],
      { ...environment, BRAID_FAKE_CODEX_HANG_PID: executorPidPath },
    );
    const parentExit = waitForExit(running.child);
    let executorPid = 0;
    try {
      await waitForMarker(executorPidPath, running);
      executorPid = Number(await readFile(executorPidPath, "utf8"));
      expect(Number.isSafeInteger(executorPid) && executorPid > 0).toBe(true);
      expect(processIsAlive(executorPid)).toBe(true);
      running.child.kill("SIGKILL");
      await expect(parentExit).resolves.toMatchObject({ signal: "SIGKILL" });

      const executionId = await onlyExecutionId(item);
      const recovery = parseJson<RecoveryReport>(
        await runCli(
          [
            "migrate",
            "recover",
            executionId,
            "--path",
            item.repositoryRoot,
            "--json",
          ],
          environment,
        ),
      );
      expect(recovery).toMatchObject({
        executionId,
        classification: "unsafe-to-resume",
        latestCheckpoint: "executor-started",
        integrity: { valid: true },
        executorLaunchPermitted: false,
        candidateCreationPermitted: false,
        cleanupEligible: false,
      });

      const resumeResult = await runCli(
        [
          "migrate",
          "resume",
          executionId,
          "--path",
          item.repositoryRoot,
          "--confirm",
          executionId,
          "--json",
        ],
        environment,
      );
      expect(resumeResult.code).toBe(12);
      const cleanupResult = await runCli(
        [
          "migrate",
          "cleanup",
          executionId,
          "--path",
          item.repositoryRoot,
          "--confirm",
          executionId,
          "--json",
        ],
        environment,
      );
      expect(cleanupResult.code).toBe(12);
      expect(await executorLaunches(counterPath)).toBe(1);
      expect(processIsAlive(executorPid)).toBe(true);
      expect(await git(item.repositoryRoot, ["rev-parse", "HEAD"])).toBe(
        mainHeadBefore,
      );
      expect(await git(item.repositoryRoot, ["status", "--porcelain=v1"])).toBe(
        "",
      );
    } finally {
      running.child.kill("SIGKILL");
      if (executorPid > 0) killDetachedTestProcess(executorPid);
    }
  }, 60_000);
});
