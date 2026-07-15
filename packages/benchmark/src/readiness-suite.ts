import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  architectureConfigSchema,
  configHash,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_CONFIG,
  executionConfigHash,
  migrationConfigHash,
  migrationProposalSchema,
  parseArchitectureConfig,
  repositoryModelSchema,
  type ArchitectureConfig,
  type ExecutionReadinessResult,
  type ExecutionReadinessState,
  type ImportEdge,
  type ModuleRecord,
  type ReadinessReason,
  type SourceFileRecord,
  type SymbolReferenceRecord,
  type TopLevelDeclarationRecord,
} from "@braid/core";
import {
  READINESS_REJECTION_EXIT_CODE,
  ScriptedTestExecutor,
  WorktreeManager,
  candidateBranchForExecution,
  captureMainCheckoutState,
  evaluateExecutionReadiness,
  runMigration,
} from "@braid/migrator";
import {
  applyValidExtraction,
  createMigrationFixture,
} from "@braid/migrator/testing";

export const READINESS_SUITE_ID = "phase-3-1-execution-readiness";
export const READINESS_SUITE_VERSION = "1.0.0";
export const READINESS_BENCHMARK_PROTOCOL_VERSION = "1.0.0";

type CaseId =
  | "local-interface-companion"
  | "local-type-alias-companion"
  | "safe-retained-helper"
  | "shared-type-retained"
  | "unresolved-declaration"
  | "predicted-reverse-dependency"
  | "predicted-new-cycle"
  | "file-budget-exceeded"
  | "protected-public-entrypoint-companion"
  | "complete-closure-execution";

type ReasonCode = ReadinessReason["code"];

interface CaseExpectation {
  id: CaseId;
  state: ExecutionReadinessState;
  companions: string[];
  blockingReasons: ReasonCode[];
}

export interface ReadinessBenchmarkCaseResult {
  id: CaseId;
  expectedState: ExecutionReadinessState;
  actualState: ExecutionReadinessState;
  expectedCompanions: string[];
  actualCompanions: string[];
  blockingReasons: ReasonCode[];
  classificationCorrect: boolean;
  companionSymbolsCorrect: boolean;
  deterministicOutput: boolean;
  executorLaunchCount: number;
  executorLaunchPrevented: boolean;
  orchestratorStatus: "not-run" | "rejected-before-executor" | "succeeded";
  mainCheckoutMutated: boolean;
  candidateCommitCreated: boolean;
  passed: boolean;
}

export interface ReadinessBenchmarkReport {
  suiteId: typeof READINESS_SUITE_ID;
  suiteVersion: typeof READINESS_SUITE_VERSION;
  protocolVersion: typeof READINESS_BENCHMARK_PROTOCOL_VERSION;
  cases: ReadinessBenchmarkCaseResult[];
  metrics: {
    totalCases: number;
    correctClassifications: number;
    readinessAccuracy: number;
    companionTruePositives: number;
    companionFalsePositives: number;
    companionFalseNegatives: number;
    companionPrecision: number;
    companionRecall: number;
    deterministicOutputs: number;
    falseReady: number;
    falseNotReady: number;
    executorLaunchesPrevented: number;
    verifiedZeroLaunchRejections: number;
    executorLaunches: number;
    mainCheckoutMutations: number;
  };
  regressions: string[];
  warnings: string[];
}

interface DependencyScenario {
  name: string;
  kind: TopLevelDeclarationRecord["kind"];
  file: string;
  module: string;
  exported: boolean;
  resolution: SymbolReferenceRecord["resolution"];
  approved?: boolean;
}

interface SyntheticScenario {
  dependency?: DependencyScenario;
  preserveExistingImportPaths?: boolean;
  maximumChangedFiles?: number;
  protectedPaths?: string[];
  publicEntrypoints?: string[];
  imports?: ImportEdge[];
  extraFiles?: SourceFileRecord[];
}

const PRIMARY_FILE = "src/orders/feature.ts";
const SOURCE_FINGERPRINT = "a".repeat(64);
const FIXED_TIME = new Date("2026-07-16T00:00:00.000Z");

const companionKey = (file: string, name: string): string => `${file}#${name}`;

const declaration = (
  name: string,
  kind: TopLevelDeclarationRecord["kind"],
  exported: boolean,
  references: SymbolReferenceRecord[] = [],
): TopLevelDeclarationRecord => ({
  name,
  kind,
  exported,
  startLine: 1,
  endLine: 1,
  references: references.map(({ name: reference }) => reference),
  symbolReferences: references,
});

const sourceFile = (
  file: string,
  declarations: TopLevelDeclarationRecord[],
): SourceFileRecord => ({
  path: file,
  linesOfCode: declarations.length,
  exportedSymbols: declarations
    .filter(({ exported }) => exported)
    .map(({ name }) => name),
  importedFiles: [],
  isTestFile: false,
  declarations,
});

const configFor = (scenario: SyntheticScenario): ArchitectureConfig =>
  architectureConfigSchema.parse({
    ...parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG),
    constraints: {
      ...parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG).constraints,
      preserve_existing_import_paths:
        scenario.preserveExistingImportPaths ?? true,
    },
    protected_paths: scenario.protectedPaths ?? [],
    migration: {
      enabled: true,
      maximumChangedFiles: scenario.maximumChangedFiles ?? 8,
      maximumSymbols: 20,
      validation: { commands: [] },
    },
  });

const syntheticInput = (scenario: SyntheticScenario) => {
  const dependency = scenario.dependency;
  const reference = dependency
    ? {
        name: dependency.name,
        resolution: dependency.resolution,
        ...(dependency.resolution === "unresolved"
          ? {}
          : { declarationFile: dependency.file }),
      }
    : undefined;
  const primaryDeclarations = [
    declaration("Primary", "function", true, reference ? [reference] : []),
    declaration("Secondary", "function", true),
    ...(dependency?.file === PRIMARY_FILE &&
    dependency.resolution !== "unresolved"
      ? [declaration(dependency.name, dependency.kind, dependency.exported)]
      : []),
  ];
  const files = [
    sourceFile(PRIMARY_FILE, primaryDeclarations),
    ...(dependency &&
    dependency.file !== PRIMARY_FILE &&
    dependency.resolution !== "unresolved"
      ? [
          sourceFile(dependency.file, [
            declaration(dependency.name, dependency.kind, dependency.exported),
          ]),
        ]
      : []),
    ...(scenario.extraFiles ?? []),
  ];
  const moduleByFile = new Map<string, string>([[PRIMARY_FILE, "orders"]]);
  if (dependency) moduleByFile.set(dependency.file, dependency.module);
  for (const edge of scenario.imports ?? []) {
    moduleByFile.set(edge.fromFile, edge.fromModule);
    moduleByFile.set(edge.toFile, edge.toModule);
  }
  const modules = new Map<string, string[]>();
  for (const file of files) {
    const module = moduleByFile.get(file.path) ?? "shared";
    modules.set(module, [...(modules.get(module) ?? []), file.path]);
  }
  const moduleRecords: ModuleRecord[] = [...modules.entries()].map(
    ([id, paths]) => ({
      id,
      kind: "feature",
      paths: [...new Set(paths)].sort(),
      fileCount: new Set(paths).size,
      exportedSymbolCount: files
        .filter((file) => paths.includes(file.path))
        .flatMap((file) => file.declarations ?? [])
        .filter(({ exported }) => exported).length,
      incomingDependencies: [],
      outgoingDependencies: [],
    }),
  );
  const config = configFor(scenario);
  const repository = repositoryModelSchema.parse({
    projectRoot: "/benchmark",
    language: "typescript",
    files,
    modules: moduleRecords,
    imports: scenario.imports ?? [],
    cycles: [],
    publicEntrypoints: scenario.publicEntrypoints ?? [],
  });
  const snapshot = createArchitectureSnapshot({
    projectRoot: repository.projectRoot,
    gitCommit: null,
    configHash: configHash(config),
    migrationConfigHash: migrationConfigHash(config),
    sourceFingerprint: SOURCE_FINGERPRINT,
    repository,
    metrics: {
      totalSourceFiles: files.length,
      totalModules: moduleRecords.length,
      totalInternalImports: (scenario.imports ?? []).length,
      totalExternalImports: 0,
      crossModuleImports: (scenario.imports ?? []).length,
      circularDependencies: 0,
      oversizedFiles: 0,
      oversizedModules: 0,
      publicEntrypointCount: (scenario.publicEntrypoints ?? []).length,
    },
    createdAt: FIXED_TIME,
  });
  const proposal = migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-EM-cafebabe",
    snapshotId: snapshot.id,
    type: "extract-module",
    title: "Synthetic readiness case",
    summary: "Evaluate one independent symbol-closure condition.",
    affectedFiles: [PRIMARY_FILE],
    affectedModules: ["orders"],
    target: {
      type: "extract-module",
      sourceFile: PRIMARY_FILE,
      sourceModule: "orders",
      candidateSymbols: ["Primary", "Secondary"],
      ...(dependency?.approved
        ? {
            approvedCompanionSymbols: [
              { file: dependency.file, symbol: dependency.name },
            ],
          }
        : {}),
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "symbol-cluster",
        sourceFile: PRIMARY_FILE,
        symbols: ["Primary", "Secondary"],
        sharedTokens: ["synthetic"],
        internalReferenceCount: reference ? 1 : 0,
      },
    ],
    expectedImpact: { simulated: [], estimated: [], unknowns: [] },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "easy", factors: ["Synthetic fixture."] },
    preconditions: ["Fixture is valid."],
    constraints: ["Preserve behavior."],
    rollbackStrategy: "Restore the source fixture.",
    ranking: {
      severity: 1,
      confidence: 3,
      expectedBenefit: 1,
      riskPenalty: 0,
      deterministicTieBreaker: "P-EM-cafebabe",
    },
  });
  return {
    proposal,
    snapshot,
    config,
    configHash: executionConfigHash(config),
    sourceFingerprint: SOURCE_FINGERPRINT,
  };
};

const syntheticCases: Array<{
  expectation: CaseExpectation;
  scenario: SyntheticScenario;
}> = [
  {
    expectation: {
      id: "local-type-alias-companion",
      state: "ready",
      companions: [companionKey(PRIMARY_FILE, "Payload")],
      blockingReasons: [],
    },
    scenario: {
      dependency: {
        name: "Payload",
        kind: "type-alias",
        file: PRIMARY_FILE,
        module: "orders",
        exported: true,
        resolution: "local",
        approved: true,
      },
    },
  },
  {
    expectation: {
      id: "safe-retained-helper",
      state: "ready-with-warnings",
      companions: [],
      blockingReasons: [],
    },
    scenario: {
      dependency: {
        name: "formatMessage",
        kind: "function",
        file: "src/shared/format.ts",
        module: "shared",
        exported: true,
        resolution: "internal",
      },
    },
  },
  {
    expectation: {
      id: "shared-type-retained",
      state: "ready-with-warnings",
      companions: [],
      blockingReasons: [],
    },
    scenario: {
      dependency: {
        name: "SharedIdentifier",
        kind: "type-alias",
        file: "src/shared/types.ts",
        module: "shared",
        exported: true,
        resolution: "internal",
      },
    },
  },
  {
    expectation: {
      id: "unresolved-declaration",
      state: "not-ready",
      companions: [],
      blockingReasons: ["required-local-declaration-unresolved"],
    },
    scenario: {
      dependency: {
        name: "MissingLocal",
        kind: "interface",
        file: PRIMARY_FILE,
        module: "orders",
        exported: false,
        resolution: "unresolved",
      },
    },
  },
  {
    expectation: {
      id: "predicted-reverse-dependency",
      state: "not-ready",
      companions: [],
      blockingReasons: ["predictable-reverse-dependency"],
    },
    scenario: {
      preserveExistingImportPaths: false,
      dependency: {
        name: "orderHelper",
        kind: "function",
        file: "src/orders/helper.ts",
        module: "orders",
        exported: true,
        resolution: "internal",
      },
    },
  },
  {
    expectation: {
      id: "predicted-new-cycle",
      state: "not-ready",
      companions: [companionKey("src/shared/contracts.ts", "SharedContract")],
      blockingReasons: ["companion-not-authorized", "predicted-cycle"],
    },
    scenario: {
      preserveExistingImportPaths: false,
      dependency: {
        name: "SharedContract",
        kind: "interface",
        file: "src/shared/contracts.ts",
        module: "shared",
        exported: true,
        resolution: "internal",
      },
      extraFiles: [sourceFile("src/notification/existing.ts", [])],
      imports: [
        {
          fromFile: "src/shared/contracts.ts",
          toFile: "src/notification/existing.ts",
          fromModule: "shared",
          toModule: "notification",
          kind: "internal",
          typeOnly: false,
        },
      ],
    },
  },
  {
    expectation: {
      id: "file-budget-exceeded",
      state: "not-ready",
      companions: [companionKey("src/contracts/local.ts", "FileContract")],
      blockingReasons: ["closure-file-budget-exceeded"],
    },
    scenario: {
      maximumChangedFiles: 2,
      dependency: {
        name: "FileContract",
        kind: "interface",
        file: "src/contracts/local.ts",
        module: "contracts",
        exported: false,
        resolution: "internal",
        approved: true,
      },
    },
  },
  {
    expectation: {
      id: "protected-public-entrypoint-companion",
      state: "not-ready",
      companions: [companionKey("src/public.ts", "PublicContract")],
      blockingReasons: ["protected-companion", "public-entrypoint-companion"],
    },
    scenario: {
      protectedPaths: ["src/public.ts"],
      publicEntrypoints: ["src/public.ts"],
      dependency: {
        name: "PublicContract",
        kind: "interface",
        file: "src/public.ts",
        module: "public",
        exported: false,
        resolution: "internal",
        approved: true,
      },
    },
  },
];

const evaluateTwice = (
  input: Parameters<typeof evaluateExecutionReadiness>[0],
): { result: ExecutionReadinessResult; deterministic: boolean } => {
  const first = evaluateExecutionReadiness(input);
  const second = evaluateExecutionReadiness(input);
  return {
    result: first,
    deterministic:
      first.deterministicEvidence.stable &&
      JSON.stringify(first) === JSON.stringify(second),
  };
};

const resultFor = (
  expectation: CaseExpectation,
  readiness: ExecutionReadinessResult,
  deterministicOutput: boolean,
  execution: Partial<
    Pick<
      ReadinessBenchmarkCaseResult,
      | "executorLaunchCount"
      | "orchestratorStatus"
      | "mainCheckoutMutated"
      | "candidateCommitCreated"
    >
  > = {},
): ReadinessBenchmarkCaseResult => {
  const actualCompanions = readiness.requiredCompanionSymbols.map(
    ({ file, name }) => companionKey(file, name),
  );
  const blockingReasons = readiness.blockingReasons.map(({ code }) => code);
  const classificationCorrect = readiness.state === expectation.state;
  const companionSymbolsCorrect =
    JSON.stringify(actualCompanions) === JSON.stringify(expectation.companions);
  const reasonsCorrect =
    JSON.stringify(blockingReasons) ===
    JSON.stringify([...expectation.blockingReasons].sort());
  const executorLaunchCount = execution.executorLaunchCount ?? 0;
  const orchestratorStatus = execution.orchestratorStatus ?? "not-run";
  const mainCheckoutMutated = execution.mainCheckoutMutated ?? false;
  const candidateCommitCreated = execution.candidateCommitCreated ?? false;
  const executionCorrect =
    orchestratorStatus === "not-run" ||
    (orchestratorStatus === "rejected-before-executor"
      ? executorLaunchCount === 0 && !candidateCommitCreated
      : executorLaunchCount === 1 && candidateCommitCreated);
  return {
    id: expectation.id,
    expectedState: expectation.state,
    actualState: readiness.state,
    expectedCompanions: expectation.companions,
    actualCompanions,
    blockingReasons,
    classificationCorrect,
    companionSymbolsCorrect,
    deterministicOutput,
    executorLaunchCount,
    executorLaunchPrevented:
      expectation.state === "not-ready" && readiness.state === "not-ready",
    orchestratorStatus,
    mainCheckoutMutated,
    candidateCommitCreated,
    passed:
      classificationCorrect &&
      companionSymbolsCorrect &&
      reasonsCorrect &&
      deterministicOutput &&
      executionCorrect &&
      !mainCheckoutMutated,
  };
};

const errorDetails = (error: unknown): { code?: string; exitCode?: number } =>
  error !== null && typeof error === "object"
    ? {
        ...(typeof (error as { code?: unknown }).code === "string"
          ? { code: (error as { code: string }).code }
          : {}),
        ...(typeof (error as { exitCode?: unknown }).exitCode === "number"
          ? { exitCode: (error as { exitCode: number }).exitCode }
          : {}),
      }
    : {};

const localInterfaceCase = async (): Promise<ReadinessBenchmarkCaseResult> => {
  const container = await mkdtemp(
    path.join(tmpdir(), "braid-readiness-interface-"),
  );
  try {
    const fixture = await createMigrationFixture(container);
    const proposal = migrationProposalSchema.parse({
      ...fixture.proposal,
      target: {
        ...fixture.proposal.target,
        approvedCompanionSymbols: undefined,
      },
    });
    const expectation: CaseExpectation = {
      id: "local-interface-companion",
      state: "not-ready",
      companions: [
        companionKey("src/orders/order-service.ts", "SentNotification"),
      ],
      blockingReasons: [
        "companion-not-authorized",
        "predictable-reverse-dependency",
        "predicted-cycle",
      ],
    };
    const evaluated = evaluateTwice({
      proposal,
      snapshot: fixture.snapshot,
      config: fixture.config,
      configHash: executionConfigHash(fixture.config),
      sourceFingerprint: fixture.snapshot.sourceFingerprint!,
    });
    const executionId = "E-c1000000-0000-4000-8000-000000000001";
    const candidateBranch = candidateBranchForExecution(executionId);
    const manager = new WorktreeManager({
      repositoryRoot: fixture.repositoryRoot,
      executionRoot: fixture.executionRoot,
    });
    const mainOptions = {
      ownedCandidateRef: `refs/heads/${candidateBranch}`,
    } as const;
    const mainBefore = await captureMainCheckoutState(
      fixture.repositoryRoot,
      mainOptions,
    );
    let executorLaunchCount = 0;
    const executor = new ScriptedTestExecutor(() => {
      executorLaunchCount += 1;
      throw new Error("not-ready proposal launched executor");
    });
    let rejectionObserved = false;
    try {
      await runMigration({
        repositoryRoot: fixture.repositoryRoot,
        proposal,
        snapshot: fixture.snapshot,
        config: fixture.config,
        approval: proposal.id,
        executor: { kind: "scripted-test" },
        migrationExecutor: executor,
        executionId,
        worktreeManager: manager,
        now: () => new Date("2026-07-16T00:01:00.000Z"),
      });
    } catch (error) {
      const details = errorDetails(error);
      rejectionObserved =
        details.code === "execution-not-ready" &&
        details.exitCode === READINESS_REJECTION_EXIT_CODE;
    }
    const mainAfter = await captureMainCheckoutState(
      fixture.repositoryRoot,
      mainOptions,
    );
    return resultFor(expectation, evaluated.result, evaluated.deterministic, {
      executorLaunchCount,
      orchestratorStatus: rejectionObserved
        ? "rejected-before-executor"
        : "not-run",
      mainCheckoutMutated: mainBefore.fingerprint !== mainAfter.fingerprint,
      candidateCommitCreated: false,
    });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
};

const completeExecutionCase =
  async (): Promise<ReadinessBenchmarkCaseResult> => {
    const container = await mkdtemp(
      path.join(tmpdir(), "braid-readiness-complete-"),
    );
    try {
      const fixture = await createMigrationFixture(container);
      const expectation: CaseExpectation = {
        id: "complete-closure-execution",
        state: "ready",
        companions: [
          companionKey("src/orders/order-service.ts", "SentNotification"),
        ],
        blockingReasons: [],
      };
      const evaluated = evaluateTwice({
        proposal: fixture.proposal,
        snapshot: fixture.snapshot,
        config: fixture.config,
        configHash: executionConfigHash(fixture.config),
        sourceFingerprint: fixture.snapshot.sourceFingerprint!,
      });
      const executionId = "E-c1000000-0000-4000-8000-000000000010";
      const candidateBranch = candidateBranchForExecution(executionId);
      const manager = new WorktreeManager({
        repositoryRoot: fixture.repositoryRoot,
        executionRoot: fixture.executionRoot,
      });
      const mainOptions = {
        ownedCandidateRef: `refs/heads/${candidateBranch}`,
      } as const;
      const mainBefore = await captureMainCheckoutState(
        fixture.repositoryRoot,
        mainOptions,
      );
      let executorLaunchCount = 0;
      const executor = new ScriptedTestExecutor(async (_plan, context) => {
        executorLaunchCount += 1;
        await applyValidExtraction(context.worktreePath);
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          events: [],
        };
      });
      const execution = await runMigration({
        repositoryRoot: fixture.repositoryRoot,
        proposal: fixture.proposal,
        snapshot: fixture.snapshot,
        config: fixture.config,
        approval: fixture.proposal.id,
        executor: { kind: "scripted-test" },
        migrationExecutor: executor,
        executionId,
        worktreeManager: manager,
        now: () => new Date("2026-07-16T00:02:00.000Z"),
      });
      const mainAfter = await captureMainCheckoutState(fixture.repositoryRoot, {
        ...mainOptions,
        ownedWorktreeGitDirectory: await manager.gitDirectory(executionId),
      });
      return resultFor(expectation, evaluated.result, evaluated.deterministic, {
        executorLaunchCount,
        orchestratorStatus:
          execution.record.status === "succeeded" ? "succeeded" : "not-run",
        mainCheckoutMutated: mainBefore.fingerprint !== mainAfter.fingerprint,
        candidateCommitCreated: execution.record.candidateCommit !== undefined,
      });
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  };

export const runReadinessBenchmark =
  async (): Promise<ReadinessBenchmarkReport> => {
    const cases: ReadinessBenchmarkCaseResult[] = [await localInterfaceCase()];
    for (const { expectation, scenario } of syntheticCases) {
      const evaluated = evaluateTwice(syntheticInput(scenario));
      cases.push(
        resultFor(expectation, evaluated.result, evaluated.deterministic),
      );
    }
    cases.push(await completeExecutionCase());

    let companionTruePositives = 0;
    let companionFalsePositives = 0;
    let companionFalseNegatives = 0;
    for (const benchmarkCase of cases) {
      const expected = new Set(benchmarkCase.expectedCompanions);
      const actual = new Set(benchmarkCase.actualCompanions);
      companionTruePositives += [...actual].filter((item) =>
        expected.has(item),
      ).length;
      companionFalsePositives += [...actual].filter(
        (item) => !expected.has(item),
      ).length;
      companionFalseNegatives += [...expected].filter(
        (item) => !actual.has(item),
      ).length;
    }
    const correctClassifications = cases.filter(
      ({ classificationCorrect }) => classificationCorrect,
    ).length;
    const precisionDenominator =
      companionTruePositives + companionFalsePositives;
    const recallDenominator = companionTruePositives + companionFalseNegatives;
    const regressions = cases
      .filter(({ passed }) => !passed)
      .map(
        ({ id, expectedState, actualState }) =>
          `${id}: expected ${expectedState}, got ${actualState}`,
      );
    return {
      suiteId: READINESS_SUITE_ID,
      suiteVersion: READINESS_SUITE_VERSION,
      protocolVersion: READINESS_BENCHMARK_PROTOCOL_VERSION,
      cases,
      metrics: {
        totalCases: cases.length,
        correctClassifications,
        readinessAccuracy: correctClassifications / cases.length,
        companionTruePositives,
        companionFalsePositives,
        companionFalseNegatives,
        companionPrecision:
          precisionDenominator === 0
            ? 1
            : companionTruePositives / precisionDenominator,
        companionRecall:
          recallDenominator === 0
            ? 1
            : companionTruePositives / recallDenominator,
        deterministicOutputs: cases.filter(
          ({ deterministicOutput }) => deterministicOutput,
        ).length,
        falseReady: cases.filter(
          ({ expectedState, actualState }) =>
            expectedState === "not-ready" && actualState !== "not-ready",
        ).length,
        falseNotReady: cases.filter(
          ({ expectedState, actualState }) =>
            expectedState !== "not-ready" && actualState === "not-ready",
        ).length,
        executorLaunchesPrevented: cases.filter(
          ({ executorLaunchPrevented }) => executorLaunchPrevented,
        ).length,
        verifiedZeroLaunchRejections: cases.filter(
          ({ orchestratorStatus, executorLaunchCount }) =>
            orchestratorStatus === "rejected-before-executor" &&
            executorLaunchCount === 0,
        ).length,
        executorLaunches: cases.reduce(
          (total, { executorLaunchCount }) => total + executorLaunchCount,
          0,
        ),
        mainCheckoutMutations: cases.filter(
          ({ mainCheckoutMutated }) => mainCheckoutMutated,
        ).length,
      },
      regressions,
      warnings: [],
    };
  };

export const readinessBenchmarkConsoleReport = (
  report: ReadinessBenchmarkReport,
): string =>
  `${[
    `${report.suiteId}@${report.suiteVersion} (${report.cases.length} cases)`,
    ...report.cases.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.actualState}`,
    ),
    `Readiness accuracy: ${report.metrics.correctClassifications}/${report.metrics.totalCases}`,
    `Companion precision: ${report.metrics.companionPrecision.toFixed(3)}`,
    `Companion recall: ${report.metrics.companionRecall.toFixed(3)}`,
    `Deterministic outputs: ${report.metrics.deterministicOutputs}/${report.metrics.totalCases}`,
    `False ready: ${report.metrics.falseReady}`,
    `False not ready: ${report.metrics.falseNotReady}`,
    `Executor launches prevented: ${report.metrics.executorLaunchesPrevented}`,
    `Verified zero-launch rejections: ${report.metrics.verifiedZeroLaunchRejections}`,
    `Main-checkout mutations: ${report.metrics.mainCheckoutMutations}`,
    `Regressions: ${report.regressions.length}`,
  ].join("\n")}\n`;
