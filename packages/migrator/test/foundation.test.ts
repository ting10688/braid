import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  architectureConfigSchema,
  configHash,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_CONFIG,
  migrationProposalSchema,
  migrationConfigHash,
  parseArchitectureConfig,
  repositoryModelSchema,
} from "@braid/core";
import {
  createExecutionPlan,
  createSourceFingerprint,
  runPreflight,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const config = architectureConfigSchema.parse({
  ...parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG),
  migration: {
    enabled: true,
    validation: {
      commands: [
        {
          id: "typecheck",
          stage: "typecheck",
          executable: "node",
          arguments: ["--check", "src/orders/order-service.ts"],
        },
      ],
    },
  },
});

const repository = repositoryModelSchema.parse({
  projectRoot: "/project",
  language: "typescript",
  files: [
    {
      path: "src/orders/order-service.ts",
      linesOfCode: 600,
      exportedSymbols: ["notificationLog", "sentNotifications"],
      importedFiles: [],
      isTestFile: false,
      declarations: [
        {
          name: "notificationLog",
          kind: "function",
          exported: true,
          startLine: 1,
          endLine: 1,
          references: ["sentNotifications"],
        },
        {
          name: "sentNotifications",
          kind: "variable",
          exported: false,
          startLine: 2,
          endLine: 2,
          references: [],
        },
      ],
    },
  ],
  modules: [
    {
      id: "orders",
      kind: "feature",
      paths: ["src/orders/order-service.ts"],
      fileCount: 1,
      exportedSymbolCount: 2,
      incomingDependencies: [],
      outgoingDependencies: [],
    },
  ],
  imports: [],
  cycles: [],
  publicEntrypoints: [],
});

const proposalFor = (snapshotId: string) =>
  migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-EM-a18d42f3",
    snapshotId,
    type: "extract-module",
    title: "Extract notifications",
    summary: "Move notification state.",
    affectedFiles: ["src/orders/order-service.ts"],
    affectedModules: ["orders"],
    target: {
      type: "extract-module",
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      candidateSymbols: ["notificationLog", "sentNotifications"],
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "symbol-cluster",
        sourceFile: "src/orders/order-service.ts",
        symbols: ["notificationLog", "sentNotifications"],
        sharedTokens: ["notification"],
        internalReferenceCount: 1,
      },
    ],
    expectedImpact: {
      simulated: [],
      estimated: [],
      unknowns: ["Import changes are unknown."],
    },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "easy", factors: ["One source module."] },
    preconditions: ["Tests pass."],
    constraints: ["Preserve behavior."],
    rollbackStrategy: "Restore declarations.",
    ranking: {
      severity: 2,
      confidence: 3,
      expectedBenefit: 1,
      riskPenalty: 0,
      deterministicTieBreaker: "P-EM-a18d42f3",
    },
  });

const gitRepository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-migrator-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src", "orders"), { recursive: true });
  await writeFile(
    path.join(root, "src", "orders", "order-service.ts"),
    "export const sentNotifications: string[] = [];\nexport const notificationLog = () => sentNotifications;\n",
  );
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Braid Test",
    "-c",
    "user.email=braid@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const { stdout } = await execFileAsync("git", [
    "-C",
    root,
    "rev-parse",
    "HEAD",
  ]);
  return { root, commit: stdout.trim() };
};

const preflightContext = async () => {
  const { root, commit } = await gitRepository();
  const fingerprint = await createSourceFingerprint(root);
  const snapshot = createArchitectureSnapshot({
    projectRoot: root,
    gitCommit: commit,
    configHash: configHash(config),
    migrationConfigHash: migrationConfigHash(config),
    sourceFingerprint: fingerprint.hash,
    repository: { ...repository, projectRoot: root },
    metrics: {
      totalSourceFiles: 1,
      totalModules: 1,
      totalInternalImports: 0,
      totalExternalImports: 0,
      crossModuleImports: 0,
      circularDependencies: 0,
      oversizedFiles: 1,
      oversizedModules: 0,
      publicEntrypointCount: 0,
    },
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  return {
    root,
    commit,
    fingerprint,
    snapshot,
    proposal: proposalFor(snapshot.id),
  };
};

describe("migrator foundation", () => {
  it("fingerprints tracked source deterministically and excludes runtime state", async () => {
    const { root } = await gitRepository();
    const first = await createSourceFingerprint(root);
    await mkdir(path.join(root, ".braid", "state"), { recursive: true });
    await writeFile(path.join(root, ".braid", "state", "runtime.json"), "{}");
    const second = await createSourceFingerprint(root);
    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "src/orders/order-service.ts",
    ]);
  });

  it("creates a stable relative-path plan", async () => {
    const { root, commit } = await gitRepository();
    const fingerprint = await createSourceFingerprint(root);
    const snapshot = createArchitectureSnapshot({
      projectRoot: root,
      gitCommit: commit,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      sourceFingerprint: fingerprint.hash,
      repository: { ...repository, projectRoot: root },
      metrics: {
        totalSourceFiles: 1,
        totalModules: 1,
        totalInternalImports: 0,
        totalExternalImports: 0,
        crossModuleImports: 0,
        circularDependencies: 0,
        oversizedFiles: 1,
        oversizedModules: 0,
        publicEntrypointCount: 0,
      },
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const proposal = proposalFor(snapshot.id);
    const input = {
      proposal,
      snapshot,
      config,
      baseCommit: commit,
      sourceFingerprint: fingerprint.hash,
    };
    const first = createExecutionPlan(input);
    const second = createExecutionPlan(input);
    expect(second.planId).toBe(first.planId);
    expect(first.expectedChange.destinationDirectory).toBe("src/notification");
    expect(JSON.stringify(first)).not.toContain(root);
    expect(first.scope.forbiddenFiles).toContain("package.json");
  });

  it("accepts exact approval and rejects the wrong value", async () => {
    const { root, commit } = await gitRepository();
    const fingerprint = await createSourceFingerprint(root);
    const snapshot = createArchitectureSnapshot({
      projectRoot: root,
      gitCommit: commit,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      sourceFingerprint: fingerprint.hash,
      repository: { ...repository, projectRoot: root },
      metrics: {
        totalSourceFiles: 1,
        totalModules: 1,
        totalInternalImports: 0,
        totalExternalImports: 0,
        crossModuleImports: 0,
        circularDependencies: 0,
        oversizedFiles: 1,
        oversizedModules: 0,
        publicEntrypointCount: 0,
      },
    });
    const proposal = proposalFor(snapshot.id);
    await expect(
      runPreflight({
        repositoryRoot: root,
        proposal,
        snapshot,
        config,
        approval: proposal.id,
        requireApproval: true,
      }),
    ).resolves.toMatchObject({ baseCommit: commit });
    await expect(
      runPreflight({
        repositoryRoot: root,
        proposal,
        snapshot,
        config,
        approval: "true",
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 3, code: "approval-mismatch" });
  });

  it("rejects missing approval and a dirty repository", async () => {
    const context = await preflightContext();
    await expect(
      runPreflight({
        repositoryRoot: context.root,
        proposal: context.proposal,
        snapshot: context.snapshot,
        config,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 3, code: "approval-mismatch" });
    await writeFile(path.join(context.root, "untracked.ts"), "export {};\n");
    await expect(
      runPreflight({
        repositoryRoot: context.root,
        proposal: context.proposal,
        snapshot: context.snapshot,
        config,
        approval: context.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 5, code: "dirty-repository" });
  });

  it("rejects stale HEAD, hidden source changes, configuration, and proposal links", async () => {
    const headContext = await preflightContext();
    await writeFile(path.join(headContext.root, "second.ts"), "export {};\n");
    await execFileAsync("git", ["-C", headContext.root, "add", "second.ts"]);
    await execFileAsync("git", [
      "-C",
      headContext.root,
      "-c",
      "user.name=Braid Test",
      "-c",
      "user.email=braid@example.invalid",
      "commit",
      "-qm",
      "second",
    ]);
    await expect(
      runPreflight({
        repositoryRoot: headContext.root,
        proposal: headContext.proposal,
        snapshot: headContext.snapshot,
        config,
        approval: headContext.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "stale-head" });

    const sourceContext = await preflightContext();
    await execFileAsync("git", [
      "-C",
      sourceContext.root,
      "update-index",
      "--assume-unchanged",
      "src/orders/order-service.ts",
    ]);
    await writeFile(
      path.join(sourceContext.root, "src", "orders", "order-service.ts"),
      "export const changedBehindGitStatus = true;\n",
    );
    await expect(
      runPreflight({
        repositoryRoot: sourceContext.root,
        proposal: sourceContext.proposal,
        snapshot: sourceContext.snapshot,
        config,
        approval: sourceContext.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "stale-source" });

    const configContext = await preflightContext();
    const changedConfig = architectureConfigSchema.parse({
      ...config,
      thresholds: {
        ...config.thresholds,
        oversized_file_lines: config.thresholds.oversized_file_lines + 1,
      },
    });
    await expect(
      runPreflight({
        repositoryRoot: configContext.root,
        proposal: configContext.proposal,
        snapshot: configContext.snapshot,
        config: changedConfig,
        approval: configContext.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "stale-config" });
    const changedMigrationConfig = architectureConfigSchema.parse({
      ...config,
      migration: {
        ...config.migration,
        maximumChangedFiles: config.migration.maximumChangedFiles - 1,
      },
    });
    await expect(
      runPreflight({
        repositoryRoot: configContext.root,
        proposal: configContext.proposal,
        snapshot: configContext.snapshot,
        config: changedMigrationConfig,
        approval: configContext.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 4,
      code: "stale-migration-config",
    });
    await expect(
      runPreflight({
        repositoryRoot: configContext.root,
        proposal: { ...configContext.proposal, snapshotId: "S-stale" },
        snapshot: configContext.snapshot,
        config,
        approval: configContext.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "stale-proposal" });
  });

  it("rejects snapshots without fingerprints", async () => {
    const context = await preflightContext();
    const { sourceFingerprint: _sourceFingerprint, ...oldSnapshot } =
      context.snapshot;
    void _sourceFingerprint;
    await expect(
      runPreflight({
        repositoryRoot: context.root,
        proposal: context.proposal,
        snapshot: oldSnapshot,
        config,
        approval: context.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({ exitCode: 4, code: "fingerprint-missing" });

    const { migrationConfigHash: _migrationConfigHash, ...legacySnapshot } =
      context.snapshot;
    void _migrationConfigHash;
    await expect(
      runPreflight({
        repositoryRoot: context.root,
        proposal: context.proposal,
        snapshot: legacySnapshot,
        config,
        approval: context.proposal.id,
        requireApproval: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 4,
      code: "migration-config-fingerprint-missing",
    });
  });

  it("rejects unsupported, risky, hard-to-reverse, protected, and public-entrypoint proposals", async () => {
    const context = await preflightContext();
    const mediumRisk = migrationProposalSchema.parse({
      ...context.proposal,
      risk: {
        level: "medium",
        points: 2,
        factors: [
          {
            type: "modules-over-2",
            points: 2,
            details: "Too many modules.",
          },
        ],
      },
    });
    const protectedProposal = migrationProposalSchema.parse({
      ...context.proposal,
      evidence: [
        ...context.proposal.evidence,
        { type: "protected-path-impact", files: ["src/protected.ts"] },
      ],
    });
    const conditionalProposal = migrationProposalSchema.parse({
      ...context.proposal,
      reversibility: {
        level: "conditional",
        factors: ["Requires a manual compatibility check."],
      },
    });
    const difficultProposal = migrationProposalSchema.parse({
      ...context.proposal,
      reversibility: {
        level: "difficult",
        factors: ["Touches state that cannot be restored automatically."],
      },
    });
    const publicProposal = migrationProposalSchema.parse({
      ...context.proposal,
      evidence: [
        ...context.proposal.evidence,
        {
          type: "public-entrypoint-impact",
          files: ["src/orders/order-service.ts"],
        },
      ],
    });
    const breakCycle = migrationProposalSchema.parse({
      ...context.proposal,
      id: "P-BC-a18d42f3",
      type: "break-cycle",
      affectedModules: ["orders", "notification"],
      target: {
        type: "break-cycle",
        cycleModules: ["orders", "notification"],
        cycleFiles: ["src/orders/order-service.ts"],
        selectedEdge: {
          fromModule: "orders",
          toModule: "notification",
          files: ["src/orders/order-service.ts"],
        },
        suggestedStrategy: "introduce-boundary",
      },
      evidence: [
        {
          type: "dependency-cycle",
          modules: ["orders", "notification"],
          files: ["src/orders/order-service.ts"],
        },
      ],
    });
    const cases = [
      [breakCycle, "unsupported-proposal"],
      [mediumRisk, "unsafe-risk"],
      [conditionalProposal, "unsafe-reversibility"],
      [difficultProposal, "unsafe-reversibility"],
      [protectedProposal, "protected-path"],
      [publicProposal, "public-entrypoint"],
    ] as const;
    for (const [proposal, code] of cases)
      await expect(
        runPreflight({
          repositoryRoot: context.root,
          proposal,
          snapshot: context.snapshot,
          config,
          approval: proposal.id,
          requireApproval: true,
        }),
      ).rejects.toMatchObject({ exitCode: 5, code });
  });

  it("keeps plan IDs independent of snapshot absolute roots and argument order-sensitive", async () => {
    const context = await preflightContext();
    const otherSnapshot = createArchitectureSnapshot({
      projectRoot: "/different/machine/project",
      gitCommit: context.commit,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      sourceFingerprint: context.fingerprint.hash,
      repository: {
        ...repository,
        projectRoot: "/different/machine/project",
      },
      metrics: context.snapshot.metrics,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const first = createExecutionPlan({
      proposal: context.proposal,
      snapshot: context.snapshot,
      config,
      baseCommit: context.commit,
      sourceFingerprint: context.fingerprint.hash,
    });
    const second = createExecutionPlan({
      proposal: proposalFor(otherSnapshot.id),
      snapshot: otherSnapshot,
      config,
      baseCommit: context.commit,
      sourceFingerprint: context.fingerprint.hash,
    });
    expect(second.planId).toBe(first.planId);
    const reorderedArguments = architectureConfigSchema.parse({
      ...config,
      migration: {
        ...config.migration,
        validation: {
          commands: config.migration.validation.commands.map((command) => ({
            ...command,
            arguments: [...command.arguments].reverse(),
          })),
        },
      },
    });
    const third = createExecutionPlan({
      proposal: context.proposal,
      snapshot: context.snapshot,
      config: reorderedArguments,
      baseCommit: context.commit,
      sourceFingerprint: context.fingerprint.hash,
    });
    expect(third.planId).not.toBe(first.planId);
  });
});
