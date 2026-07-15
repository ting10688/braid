import path from "node:path";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeRepository } from "@braid/analyzer";
import {
  configHash,
  createArchitectureSnapshot,
  loadArchitectureConfig,
  migrationConfigHash,
  migrationProposalSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type MigrationProposal,
} from "@braid/core";
import { CONFIG_FILE } from "@braid/shared";
import { createSourceFingerprint } from "../source-fingerprint.js";

const execFileAsync = promisify(execFile);
const templateRoot = fileURLToPath(
  new URL("../../test/fixtures/notification-extraction", import.meta.url),
);

export interface MigrationFixture {
  container: string;
  repositoryRoot: string;
  executionRoot: string;
  baseCommit: string;
  config: ArchitectureConfig;
  snapshot: ArchitectureSnapshot;
  proposal: MigrationProposal;
}

export const git = async (
  root: string,
  arguments_: readonly string[],
): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

export const createMigrationFixture = async (
  container: string,
  options: {
    failingValidation?: boolean;
    committingValidation?: boolean;
  } = {},
): Promise<MigrationFixture> => {
  const repositoryRoot = path.join(container, "main");
  const executionRoot = path.join(container, "worktrees");
  await cp(templateRoot, repositoryRoot, { recursive: true });
  if (options.failingValidation) {
    await writeFile(
      path.join(repositoryRoot, "scripts", "fail.mjs"),
      "console.error('intentional failure'); process.exit(1);\n",
    );
    const configPath = path.join(repositoryRoot, CONFIG_FILE);
    const configText = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${configText}\n      - id: intentional-failure\n        stage: custom-safe-check\n        executable: node\n        arguments:\n          - scripts/fail.mjs\n        workingDirectory: .\n        timeoutMs: 30000\n`,
    );
  }
  if (options.committingValidation) {
    await writeFile(
      path.join(repositoryRoot, "scripts", "commit.mjs"),
      "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '-A']);\nexecFileSync('git', ['-c', 'user.name=Unsafe Validation', '-c', 'user.email=unsafe@example.invalid', 'commit', '-qm', 'unauthorized validation commit']);\n",
    );
    const configPath = path.join(repositoryRoot, CONFIG_FILE);
    const configText = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${configText}\n      - id: mutation-attempt\n        stage: custom-safe-check\n        executable: node\n        arguments:\n          - scripts/commit.mjs\n        workingDirectory: .\n        timeoutMs: 30000\n`,
    );
  }
  await mkdir(executionRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", repositoryRoot]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, [
    "-c",
    "user.name=Braid Fixture",
    "-c",
    "user.email=braid-fixture@example.invalid",
    "commit",
    "-qm",
    "notification fixture",
  ]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const config = await loadArchitectureConfig(
    path.join(repositoryRoot, CONFIG_FILE),
  );
  const [analysis, fingerprint] = await Promise.all([
    analyzeRepository(repositoryRoot, config),
    createSourceFingerprint(repositoryRoot),
  ]);
  const snapshot = createArchitectureSnapshot({
    projectRoot: repositoryRoot,
    gitCommit: baseCommit,
    configHash: configHash(config),
    migrationConfigHash: migrationConfigHash(config),
    sourceFingerprint: fingerprint.hash,
    repository: analysis.repository,
    metrics: analysis.metrics,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  const proposal = migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-EM-a18d42f3",
    snapshotId: snapshot.id,
    type: "extract-module",
    title: "Extract order notifications",
    summary: "Move cohesive notification state and behavior out of orders.",
    affectedFiles: ["src/orders/order-service.ts"],
    affectedModules: ["orders"],
    target: {
      type: "extract-module",
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      candidateSymbols: [
        "notificationLog",
        "resetNotifications",
        "sendOrderNotification",
        "sentNotifications",
      ],
      approvedCompanionSymbols: [
        {
          file: "src/orders/order-service.ts",
          symbol: "SentNotification",
        },
      ],
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "symbol-cluster",
        sourceFile: "src/orders/order-service.ts",
        symbols: [
          "notificationLog",
          "resetNotifications",
          "sendOrderNotification",
          "sentNotifications",
        ],
        sharedTokens: ["notification", "notifications"],
        internalReferenceCount: 4,
      },
    ],
    expectedImpact: {
      simulated: [],
      estimated: [
        {
          metric: "crossModuleImports",
          direction: "increase",
          delta: 1,
          rationale: "Orders will import its internal notification module.",
        },
      ],
      unknowns: [],
    },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: {
      level: "easy",
      factors: ["One internal source file and one destination module."],
    },
    preconditions: ["Fixture validation passes."],
    constraints: ["Preserve order behavior and import compatibility."],
    rollbackStrategy: "Restore the original declarations in orders.",
    ranking: {
      severity: 2,
      confidence: 3,
      expectedBenefit: 2,
      riskPenalty: 0,
      deterministicTieBreaker: "P-EM-a18d42f3",
    },
  });
  return {
    container,
    repositoryRoot,
    executionRoot,
    baseCommit,
    config,
    snapshot,
    proposal,
  };
};

export const applyValidExtraction = async (
  worktreePath: string,
  options: { introduceCycle?: boolean } = {},
): Promise<void> => {
  const notificationDirectory = path.join(worktreePath, "src", "notification");
  await mkdir(notificationDirectory, { recursive: true });
  await writeFile(
    path.join(notificationDirectory, "notification-service.ts"),
    `${
      options.introduceCycle
        ? 'import type { Order } from "../orders/order-service.ts";\n\nexport type NotificationOrder = Order;\n\n'
        : ""
    }export interface SentNotification {
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
  notificationLog.push(\`${"${orderId}:${message}"}\`);
  return notification;
};

export const resetNotifications = (): void => {
  notificationLog.length = 0;
  sentNotifications.length = 0;
};
`,
  );
  await writeFile(
    path.join(worktreePath, "src", "orders", "order-service.ts"),
    `import { sendOrderNotification } from "../notification/notification-service.ts";

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
`,
  );
};
