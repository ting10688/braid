import path from "node:path";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
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
  type ImportEdge,
  type MigrationProposal,
  type ModuleRecord,
  type ProposalRepairSuggestion,
  type ProposalRepairSuggestionState,
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
  suggestProposalRepair,
} from "@braid/migrator";
import {
  applyValidExtraction,
  createMigrationFixture,
  git,
} from "@braid/migrator/testing";

export const PROPOSAL_REPAIR_SUGGESTION_SUITE_ID =
  "phase-3-2-proposal-repair-suggestions";
export const PROPOSAL_REPAIR_SUGGESTION_SUITE_VERSION = "1.0.0";
export const PROPOSAL_REPAIR_SUGGESTION_PROTOCOL_VERSION = "1.0.0";

type CaseId =
  | "missing-interface-actionable"
  | "missing-type-alias-actionable"
  | "multiple-required-companions"
  | "minimal-unnecessary-companion"
  | "retained-helper"
  | "safe-imported-internal-type"
  | "unresolved-declaration"
  | "protected-public-entrypoint"
  | "persistent-cycle"
  | "symbol-budget"
  | "legacy-evidence"
  | "in-memory-revision-ready"
  | "original-proposal-gated"
  | "separately-revised-execution";

export interface ProposalRepairSuggestionCaseResult {
  id: CaseId;
  expectedState: ProposalRepairSuggestionState;
  actualState: ProposalRepairSuggestionState;
  expectedAdditions: string[];
  actualAdditions: string[];
  stateCorrect: boolean;
  additionsCorrect: boolean;
  minimalSetCorrect: boolean;
  deterministicSuggestionId: boolean;
  deterministicSymbolOrder: boolean;
  deterministicOutput: boolean;
  evidenceCorrect: boolean;
  proposalMutated: boolean;
  executorLaunchCount: number;
  originalExecutorLaunchPrevented: boolean;
  revisedProposalReachedReadiness: boolean;
  candidateCommitCreated: boolean;
  candidateDiscarded: boolean;
  mainCheckoutMutated: boolean;
  unauthorizedScopeAccepted: boolean;
  sideEffectsBeforeExecution: {
    worktreesCreated: number;
    branchesCreated: number;
    executionRecordsCreated: number;
  };
  passed: boolean;
}

export interface ProposalRepairSuggestionBenchmarkReport {
  suiteId: typeof PROPOSAL_REPAIR_SUGGESTION_SUITE_ID;
  suiteVersion: typeof PROPOSAL_REPAIR_SUGGESTION_SUITE_VERSION;
  protocolVersion: typeof PROPOSAL_REPAIR_SUGGESTION_PROTOCOL_VERSION;
  cases: ProposalRepairSuggestionCaseResult[];
  metrics: {
    totalCases: number;
    correctSuggestionStates: number;
    suggestionStateAccuracy: number;
    actionableTruePositives: number;
    actionableFalsePositives: number;
    actionableFalseNegatives: number;
    actionableSuggestionPrecision: number;
    actionableSuggestionRecall: number;
    minimalSetsCorrect: number;
    minimalSetAccuracy: number;
    falseActionable: number;
    falseUnavailable: number;
    deterministicSuggestionIds: number;
    deterministicSymbolOrders: number;
    originalExecutorLaunchesPrevented: number;
    revisedProposalsSuccessfullyReachingReadiness: number;
    mainCheckoutMutations: number;
    unauthorizedScopeAccepted: number;
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
  referenced?: boolean;
}

interface SyntheticScenario {
  dependencies?: DependencyScenario[];
  legacyPrimaryEvidence?: boolean;
  maximumChangedFiles?: number;
  maximumSymbols?: number;
  protectedPaths?: string[];
  publicEntrypoints?: string[];
  preserveExistingImportPaths?: boolean;
  imports?: ImportEdge[];
  extraFiles?: SourceFileRecord[];
}

interface CaseDefinition {
  id: Exclude<
    CaseId,
    | "in-memory-revision-ready"
    | "original-proposal-gated"
    | "separately-revised-execution"
  >;
  expectedState: ProposalRepairSuggestionState;
  expectedAdditions: string[];
  scenario: SyntheticScenario;
  evidenceCorrect?: (suggestion: ProposalRepairSuggestion) => boolean;
}

const PRIMARY_FILE = "src/orders/feature.ts";
const SOURCE_FINGERPRINT = "a".repeat(64);
const FIXED_TIME = new Date("2026-07-16T00:00:00.000Z");
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const locatorKey = (file: string, name: string): string => `${file}#${name}`;

const declaration = (
  name: string,
  kind: TopLevelDeclarationRecord["kind"],
  exported: boolean,
  references: SymbolReferenceRecord[] = [],
  legacy = false,
): TopLevelDeclarationRecord => ({
  name,
  kind,
  exported,
  startLine: 1,
  endLine: 1,
  references: references.map(({ name: reference }) => reference),
  ...(legacy ? {} : { symbolReferences: references }),
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

const configFor = (scenario: SyntheticScenario): ArchitectureConfig => {
  const defaults = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
  return architectureConfigSchema.parse({
    ...defaults,
    constraints: {
      ...defaults.constraints,
      preserve_existing_import_paths:
        scenario.preserveExistingImportPaths ?? true,
    },
    protected_paths: scenario.protectedPaths ?? [],
    migration: {
      enabled: true,
      maximumChangedFiles: scenario.maximumChangedFiles ?? 8,
      maximumSymbols: scenario.maximumSymbols ?? 20,
      validation: { commands: [] },
    },
  });
};

const syntheticInput = (scenario: SyntheticScenario) => {
  const dependencies = scenario.dependencies ?? [];
  const references: SymbolReferenceRecord[] = dependencies
    .filter(({ referenced }) => referenced ?? true)
    .map((dependency) => ({
      name: dependency.name,
      resolution: dependency.resolution,
      ...(dependency.resolution === "unresolved"
        ? {}
        : { declarationFile: dependency.file }),
    }));
  const primaryDeclarations = [
    declaration(
      "Primary",
      "function",
      true,
      references,
      scenario.legacyPrimaryEvidence,
    ),
    declaration("Secondary", "function", true),
    ...dependencies
      .filter(
        ({ file, resolution }) =>
          file === PRIMARY_FILE && resolution !== "unresolved",
      )
      .map(({ name, kind, exported }) => declaration(name, kind, exported)),
  ];
  const dependenciesByFile = new Map<string, DependencyScenario[]>();
  for (const dependency of dependencies)
    if (
      dependency.file !== PRIMARY_FILE &&
      dependency.resolution !== "unresolved"
    )
      dependenciesByFile.set(dependency.file, [
        ...(dependenciesByFile.get(dependency.file) ?? []),
        dependency,
      ]);
  const files = [
    sourceFile(PRIMARY_FILE, primaryDeclarations),
    ...[...dependenciesByFile.entries()].map(([file, items]) =>
      sourceFile(
        file,
        items.map(({ name, kind, exported }) =>
          declaration(name, kind, exported),
        ),
      ),
    ),
    ...(scenario.extraFiles ?? []),
  ];
  const moduleByFile = new Map<string, string>([[PRIMARY_FILE, "orders"]]);
  for (const dependency of dependencies)
    moduleByFile.set(dependency.file, dependency.module);
  for (const edge of scenario.imports ?? []) {
    moduleByFile.set(edge.fromFile, edge.fromModule);
    moduleByFile.set(edge.toFile, edge.toModule);
  }
  const pathsByModule = new Map<string, string[]>();
  for (const file of files) {
    const module = moduleByFile.get(file.path) ?? "shared";
    pathsByModule.set(module, [
      ...(pathsByModule.get(module) ?? []),
      file.path,
    ]);
  }
  const modules: ModuleRecord[] = [...pathsByModule.entries()].map(
    ([id, paths]) => ({
      id,
      kind: "feature",
      paths: [...new Set(paths)].sort(compare),
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
    modules,
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
      totalModules: modules.length,
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
  const approvedCompanionSymbols = dependencies
    .filter(({ approved }) => approved)
    .map(({ file, name: symbol }) => ({ file, symbol }));
  const proposal = migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-EM-cafebabe",
    snapshotId: snapshot.id,
    type: "extract-module",
    title: "Synthetic repair suggestion case",
    summary: "Evaluate one independent bounded repair condition.",
    affectedFiles: [PRIMARY_FILE],
    affectedModules: ["orders"],
    target: {
      type: "extract-module",
      sourceFile: PRIMARY_FILE,
      sourceModule: "orders",
      candidateSymbols: ["Primary", "Secondary"],
      ...(approvedCompanionSymbols.length > 0
        ? { approvedCompanionSymbols }
        : {}),
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "symbol-cluster",
        sourceFile: PRIMARY_FILE,
        symbols: ["Primary", "Secondary"],
        sharedTokens: ["synthetic"],
        internalReferenceCount: references.length,
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

const definitions: CaseDefinition[] = [
  {
    id: "missing-interface-actionable",
    expectedState: "actionable",
    expectedAdditions: [locatorKey(PRIMARY_FILE, "LocalContract")],
    scenario: {
      dependencies: [
        {
          name: "LocalContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
      ],
    },
  },
  {
    id: "missing-type-alias-actionable",
    expectedState: "actionable",
    expectedAdditions: [locatorKey(PRIMARY_FILE, "LocalPayload")],
    scenario: {
      dependencies: [
        {
          name: "LocalPayload",
          kind: "type-alias",
          file: PRIMARY_FILE,
          module: "orders",
          exported: true,
          resolution: "local",
        },
      ],
    },
  },
  {
    id: "multiple-required-companions",
    expectedState: "actionable",
    expectedAdditions: [
      locatorKey(PRIMARY_FILE, "AlphaContract"),
      locatorKey(PRIMARY_FILE, "ZuluPayload"),
    ],
    scenario: {
      dependencies: [
        {
          name: "ZuluPayload",
          kind: "type-alias",
          file: PRIMARY_FILE,
          module: "orders",
          exported: true,
          resolution: "local",
        },
        {
          name: "AlphaContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
      ],
    },
  },
  {
    id: "minimal-unnecessary-companion",
    expectedState: "actionable",
    expectedAdditions: [locatorKey(PRIMARY_FILE, "RequiredContract")],
    scenario: {
      dependencies: [
        {
          name: "RequiredContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
        {
          name: "UnnecessaryPossibleCompanion",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: true,
          resolution: "local",
          referenced: false,
        },
      ],
    },
    evidenceCorrect: (suggestion) => {
      const unnecessary = locatorKey(
        PRIMARY_FILE,
        "UnnecessaryPossibleCompanion",
      );
      return (
        !additionsFor(suggestion).includes(unnecessary) &&
        suggestion.minimization.candidateSymbols.some(
          ({ file, name }) => locatorKey(file, name) === unnecessary,
        ) &&
        suggestion.minimization.eliminatedSymbols.some(
          ({ file, name }) => locatorKey(file, name) === unnecessary,
        )
      );
    },
  },
  {
    id: "retained-helper",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      preserveExistingImportPaths: false,
      dependencies: [
        {
          name: "formatMessage",
          kind: "function",
          file: "src/shared/format.ts",
          module: "shared",
          exported: true,
          resolution: "internal",
        },
        {
          name: "MissingLocal",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "unresolved",
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.retainedDependencies.some(
        ({ symbol }) =>
          locatorKey(symbol.file, symbol.name) ===
          locatorKey("src/shared/format.ts", "formatMessage"),
      ) &&
      suggestion.safelyImportedDependencies.some(
        (dependency) =>
          dependency.kind === "internal" &&
          locatorKey(
            dependency.dependency.symbol.file,
            dependency.dependency.symbol.name,
          ) === locatorKey("src/shared/format.ts", "formatMessage"),
      ),
  },
  {
    id: "safe-imported-internal-type",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      preserveExistingImportPaths: false,
      dependencies: [
        {
          name: "SharedIdentifier",
          kind: "type-alias",
          file: "src/shared/types.ts",
          module: "shared",
          exported: true,
          resolution: "internal",
        },
        {
          name: "MissingLocal",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "unresolved",
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.safelyImportedDependencies.some(
        (dependency) =>
          dependency.kind === "internal" &&
          locatorKey(
            dependency.dependency.symbol.file,
            dependency.dependency.symbol.name,
          ) === locatorKey("src/shared/types.ts", "SharedIdentifier"),
      ),
  },
  {
    id: "unresolved-declaration",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      dependencies: [
        {
          name: "MissingLocal",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "unresolved",
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.unresolvedDependencies.some(
        ({ name }) => name === "MissingLocal",
      ),
  },
  {
    id: "protected-public-entrypoint",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      protectedPaths: ["src/public.ts"],
      publicEntrypoints: ["src/public.ts"],
      dependencies: [
        {
          name: "PublicContract",
          kind: "interface",
          file: "src/public.ts",
          module: "public",
          exported: false,
          resolution: "internal",
        },
      ],
    },
    evidenceCorrect: (suggestion) => {
      const codes = new Set(
        suggestion.remainingBlockers.map(({ code }) => code),
      );
      return (
        codes.has("protected-companion") &&
        codes.has("public-entrypoint-companion")
      );
    },
  },
  {
    id: "persistent-cycle",
    expectedState: "partial",
    expectedAdditions: [locatorKey(PRIMARY_FILE, "LocalContract")],
    scenario: {
      dependencies: [
        {
          name: "LocalContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
      ],
      extraFiles: [sourceFile("src/notification/existing.ts", [])],
      imports: [
        {
          fromFile: "src/notification/existing.ts",
          toFile: PRIMARY_FILE,
          fromModule: "notification",
          toModule: "orders",
          kind: "internal",
          typeOnly: false,
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.predictedCycleRisks.length > 0 &&
      suggestion.remainingBlockers.some(
        ({ code }) => code === "predicted-cycle",
      ),
  },
  {
    id: "symbol-budget",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      maximumSymbols: 2,
      dependencies: [
        {
          name: "BudgetContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.remainingBlockers.some(
        ({ code }) => code === "closure-symbol-budget-exceeded",
      ),
  },
  {
    id: "legacy-evidence",
    expectedState: "unavailable",
    expectedAdditions: [],
    scenario: {
      legacyPrimaryEvidence: true,
      dependencies: [
        {
          name: "LegacyContract",
          kind: "interface",
          file: PRIMARY_FILE,
          module: "orders",
          exported: false,
          resolution: "local",
        },
      ],
    },
    evidenceCorrect: (suggestion) =>
      suggestion.warnings.some(
        ({ code }) => code === "legacy-reference-evidence",
      ),
  },
];

const additionsFor = (suggestion: ProposalRepairSuggestion): string[] =>
  suggestion.suggestedCompanionSymbolAdditions.map(({ symbol }) =>
    locatorKey(symbol.file, symbol.name),
  );

const emptySideEffects = () => ({
  worktreesCreated: 0,
  branchesCreated: 0,
  executionRecordsCreated: 0,
});

const baseResult = (
  id: CaseId,
  expectedState: ProposalRepairSuggestionState,
  expectedAdditions: string[],
  suggestion: ProposalRepairSuggestion,
  repeated: ProposalRepairSuggestion,
  proposalMutated: boolean,
  evidenceCorrect = true,
  overrides: Partial<ProposalRepairSuggestionCaseResult> = {},
): ProposalRepairSuggestionCaseResult => {
  const actualAdditions = additionsFor(suggestion);
  const stateCorrect = suggestion.state === expectedState;
  const additionsCorrect =
    JSON.stringify(actualAdditions) === JSON.stringify(expectedAdditions);
  const deterministicSuggestionId =
    suggestion.suggestionId === repeated.suggestionId;
  const deterministicSymbolOrder =
    JSON.stringify(actualAdditions) ===
    JSON.stringify([...actualAdditions].sort(compare));
  const deterministicOutput =
    deterministicSuggestionId &&
    JSON.stringify(suggestion) === JSON.stringify(repeated);
  const minimalSetCorrect =
    expectedState === "actionable"
      ? suggestion.minimal && additionsCorrect
      : !suggestion.minimal;
  const result: ProposalRepairSuggestionCaseResult = {
    id,
    expectedState,
    actualState: suggestion.state,
    expectedAdditions,
    actualAdditions,
    stateCorrect,
    additionsCorrect,
    minimalSetCorrect,
    deterministicSuggestionId,
    deterministicSymbolOrder,
    deterministicOutput,
    evidenceCorrect,
    proposalMutated,
    executorLaunchCount: 0,
    originalExecutorLaunchPrevented: false,
    revisedProposalReachedReadiness: false,
    candidateCommitCreated: false,
    candidateDiscarded: false,
    mainCheckoutMutated: false,
    unauthorizedScopeAccepted: false,
    sideEffectsBeforeExecution: emptySideEffects(),
    passed: false,
    ...overrides,
  };
  result.passed =
    stateCorrect &&
    additionsCorrect &&
    minimalSetCorrect &&
    deterministicOutput &&
    deterministicSymbolOrder &&
    evidenceCorrect &&
    !proposalMutated &&
    !result.mainCheckoutMutated &&
    !result.unauthorizedScopeAccepted &&
    (overrides.passed ?? true);
  return result;
};

const genericCase = (definition: CaseDefinition) => {
  const input = syntheticInput(definition.scenario);
  const proposalBefore = JSON.stringify(input.proposal);
  const suggestion = suggestProposalRepair(input);
  const repeated = suggestProposalRepair(input);
  return baseResult(
    definition.id,
    definition.expectedState,
    definition.expectedAdditions,
    suggestion,
    repeated,
    JSON.stringify(input.proposal) !== proposalBefore,
    definition.evidenceCorrect?.(suggestion) ?? true,
  );
};

const incompleteFixtureInput = (
  fixture: Awaited<ReturnType<typeof createMigrationFixture>>,
) => ({
  proposal: migrationProposalSchema.parse({
    ...fixture.proposal,
    target: {
      ...fixture.proposal.target,
      approvedCompanionSymbols: undefined,
    },
  }),
  snapshot: fixture.snapshot,
  config: fixture.config,
  configHash: executionConfigHash(fixture.config),
  sourceFingerprint: fixture.snapshot.sourceFingerprint!,
});

const revisedProposalFor = (
  proposal: MigrationProposal,
  suggestion: ProposalRepairSuggestion,
  id = proposal.id,
): MigrationProposal =>
  migrationProposalSchema.parse({
    ...structuredClone(proposal),
    id,
    target: {
      ...proposal.target,
      approvedCompanionSymbols: [
        ...(proposal.target.type === "extract-module"
          ? (proposal.target.approvedCompanionSymbols ?? [])
          : []),
        ...suggestion.suggestedCompanionSymbolAdditions.map(({ symbol }) => ({
          file: symbol.file,
          symbol: symbol.name,
        })),
      ],
    },
    ranking: { ...proposal.ranking, deterministicTieBreaker: id },
  });

const inMemoryRevisionCase =
  async (): Promise<ProposalRepairSuggestionCaseResult> => {
    const container = await mkdtemp(
      path.join(tmpdir(), "braid-repair-memory-"),
    );
    try {
      const fixture = await createMigrationFixture(container);
      const input = incompleteFixtureInput(fixture);
      const proposalBefore = JSON.stringify(input.proposal);
      const suggestion = suggestProposalRepair(input);
      const repeated = suggestProposalRepair(input);
      const revised = revisedProposalFor(input.proposal, suggestion);
      const readiness = evaluateExecutionReadiness({
        ...input,
        proposal: revised,
      });
      return baseResult(
        "in-memory-revision-ready",
        "actionable",
        [locatorKey("src/orders/order-service.ts", "SentNotification")],
        suggestion,
        repeated,
        JSON.stringify(input.proposal) !== proposalBefore,
        true,
        {
          revisedProposalReachedReadiness:
            readiness.state === "ready" ||
            readiness.state === "ready-with-warnings",
          passed:
            (readiness.state === "ready" ||
              readiness.state === "ready-with-warnings") &&
            readiness.predictedCycleRisks.length === 0,
        },
      );
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  };

const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const originalProposalGatedCase =
  async (): Promise<ProposalRepairSuggestionCaseResult> => {
    const container = await mkdtemp(path.join(tmpdir(), "braid-repair-gated-"));
    try {
      const fixture = await createMigrationFixture(container);
      const input = incompleteFixtureInput(fixture);
      const proposalBefore = JSON.stringify(input.proposal);
      const branchesBefore = await git(fixture.repositoryRoot, [
        "branch",
        "--list",
        "braid/exec/*",
      ]);
      const worktreesBefore = await git(fixture.repositoryRoot, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      const suggestion = suggestProposalRepair(input);
      const repeated = suggestProposalRepair(input);
      const sideEffectsBeforeExecution = {
        branchesCreated:
          (await git(fixture.repositoryRoot, [
            "branch",
            "--list",
            "braid/exec/*",
          ])) === branchesBefore
            ? 0
            : 1,
        worktreesCreated:
          (await git(fixture.repositoryRoot, [
            "worktree",
            "list",
            "--porcelain",
          ])) === worktreesBefore &&
          (await readdir(fixture.executionRoot)).length === 0
            ? 0
            : 1,
        executionRecordsCreated: (await exists(
          path.join(fixture.repositoryRoot, ".braid", "executions"),
        ))
          ? 1
          : 0,
      };
      const executionId = "E-32000000-0000-4000-8000-000000000013";
      const manager = new WorktreeManager({
        repositoryRoot: fixture.repositoryRoot,
        executionRoot: fixture.executionRoot,
      });
      const mainBefore = await captureMainCheckoutState(
        fixture.repositoryRoot,
        {
          ownedCandidateRef: `refs/heads/${candidateBranchForExecution(executionId)}`,
        },
      );
      let executorLaunchCount = 0;
      const executor = new ScriptedTestExecutor(() => {
        executorLaunchCount += 1;
        throw new Error("original not-ready proposal launched executor");
      });
      let rejectionObserved = false;
      try {
        await runMigration({
          repositoryRoot: fixture.repositoryRoot,
          ...input,
          approval: input.proposal.id,
          executor: { kind: "scripted-test" },
          migrationExecutor: executor,
          executionId,
          worktreeManager: manager,
          now: () => new Date("2026-07-16T00:13:00.000Z"),
        });
      } catch (error) {
        const item = error as { code?: string; exitCode?: number };
        rejectionObserved =
          item.code === "execution-not-ready" &&
          item.exitCode === READINESS_REJECTION_EXIT_CODE;
      }
      const mainAfter = await captureMainCheckoutState(fixture.repositoryRoot, {
        ownedCandidateRef: `refs/heads/${candidateBranchForExecution(executionId)}`,
      });
      return baseResult(
        "original-proposal-gated",
        "actionable",
        [locatorKey("src/orders/order-service.ts", "SentNotification")],
        suggestion,
        repeated,
        JSON.stringify(input.proposal) !== proposalBefore,
        true,
        {
          executorLaunchCount,
          originalExecutorLaunchPrevented:
            rejectionObserved && executorLaunchCount === 0,
          sideEffectsBeforeExecution,
          mainCheckoutMutated: mainBefore.fingerprint !== mainAfter.fingerprint,
          passed:
            rejectionObserved &&
            executorLaunchCount === 0 &&
            Object.values(sideEffectsBeforeExecution).every(
              (count) => count === 0,
            ) &&
            (await git(fixture.repositoryRoot, [
              "branch",
              "--list",
              "braid/exec/*",
            ])) === "" &&
            (await readdir(fixture.executionRoot)).length === 0,
        },
      );
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  };

const executorResult = () => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  events: [],
});

const separatelyRevisedExecutionCase =
  async (): Promise<ProposalRepairSuggestionCaseResult> => {
    const container = await mkdtemp(
      path.join(tmpdir(), "braid-repair-execution-"),
    );
    try {
      const fixture = await createMigrationFixture(container);
      const input = incompleteFixtureInput(fixture);
      const proposalBefore = JSON.stringify(input.proposal);
      const suggestion = suggestProposalRepair(input);
      const repeated = suggestProposalRepair(input);
      const revised = revisedProposalFor(
        input.proposal,
        suggestion,
        "P-EM-deadbeef",
      );
      const readiness = evaluateExecutionReadiness({
        ...input,
        proposal: revised,
      });
      const manager = new WorktreeManager({
        repositoryRoot: fixture.repositoryRoot,
        executionRoot: fixture.executionRoot,
      });
      const mainBefore = await captureMainCheckoutState(fixture.repositoryRoot);
      let executorLaunchCount = 0;
      const executor = new ScriptedTestExecutor(async (_plan, context) => {
        executorLaunchCount += 1;
        await applyValidExtraction(context.worktreePath);
        return executorResult();
      });
      let explicitApprovalRequired = false;
      try {
        await runMigration({
          repositoryRoot: fixture.repositoryRoot,
          ...input,
          proposal: revised,
          approval: input.proposal.id,
          executor: { kind: "scripted-test" },
          migrationExecutor: executor,
          executionId: "E-32000000-0000-4000-8000-000000000140",
          worktreeManager: manager,
        });
      } catch (error) {
        explicitApprovalRequired =
          (error as { code?: string }).code === "approval-mismatch";
      }
      const executionId = "E-32000000-0000-4000-8000-000000000014";
      const execution = await runMigration({
        repositoryRoot: fixture.repositoryRoot,
        ...input,
        proposal: revised,
        approval: revised.id,
        executor: { kind: "scripted-test" },
        migrationExecutor: executor,
        executionId,
        worktreeManager: manager,
        now: () => new Date("2026-07-16T00:14:00.000Z"),
      });
      const candidateCommitCreated =
        execution.record.status === "succeeded" &&
        execution.record.candidateCommit !== undefined;
      const unauthorizedScopeAccepted =
        candidateCommitCreated &&
        (execution.record.scope?.violations.length ?? 0) > 0;
      await manager.discard(executionId);
      const mainAfter = await captureMainCheckoutState(fixture.repositoryRoot);
      const candidateDiscarded =
        (await git(fixture.repositoryRoot, [
          "branch",
          "--list",
          candidateBranchForExecution(executionId),
        ])) === "" &&
        !(await exists(path.join(fixture.executionRoot, executionId)));
      const revisedProposalReachedReadiness =
        readiness.state === "ready" ||
        readiness.state === "ready-with-warnings";
      return baseResult(
        "separately-revised-execution",
        "actionable",
        [locatorKey("src/orders/order-service.ts", "SentNotification")],
        suggestion,
        repeated,
        JSON.stringify(input.proposal) !== proposalBefore,
        true,
        {
          executorLaunchCount,
          revisedProposalReachedReadiness,
          candidateCommitCreated,
          candidateDiscarded,
          mainCheckoutMutated: mainBefore.fingerprint !== mainAfter.fingerprint,
          unauthorizedScopeAccepted,
          passed:
            explicitApprovalRequired &&
            revisedProposalReachedReadiness &&
            candidateCommitCreated &&
            candidateDiscarded &&
            executorLaunchCount === 1,
        },
      );
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  };

export const runProposalRepairSuggestionBenchmark =
  async (): Promise<ProposalRepairSuggestionBenchmarkReport> => {
    const cases: ProposalRepairSuggestionCaseResult[] =
      definitions.map(genericCase);
    cases.push(
      await inMemoryRevisionCase(),
      await originalProposalGatedCase(),
      await separatelyRevisedExecutionCase(),
    );
    const correctSuggestionStates = cases.filter(
      ({ stateCorrect }) => stateCorrect,
    ).length;
    const actionableTruePositives = cases.filter(
      ({ expectedState, actualState }) =>
        expectedState === "actionable" && actualState === "actionable",
    ).length;
    const actionableFalsePositives = cases.filter(
      ({ expectedState, actualState }) =>
        expectedState !== "actionable" && actualState === "actionable",
    ).length;
    const actionableFalseNegatives = cases.filter(
      ({ expectedState, actualState }) =>
        expectedState === "actionable" && actualState !== "actionable",
    ).length;
    const precisionDenominator =
      actionableTruePositives + actionableFalsePositives;
    const recallDenominator =
      actionableTruePositives + actionableFalseNegatives;
    const minimalCases = cases.filter(
      ({ expectedState }) => expectedState === "actionable",
    );
    const minimalSetsCorrect = minimalCases.filter(
      ({ minimalSetCorrect }) => minimalSetCorrect,
    ).length;
    const regressions = cases
      .filter(({ passed }) => !passed)
      .map(
        ({ id, expectedState, actualState }) =>
          `${id}: expected ${expectedState}, got ${actualState}`,
      );
    return {
      suiteId: PROPOSAL_REPAIR_SUGGESTION_SUITE_ID,
      suiteVersion: PROPOSAL_REPAIR_SUGGESTION_SUITE_VERSION,
      protocolVersion: PROPOSAL_REPAIR_SUGGESTION_PROTOCOL_VERSION,
      cases,
      metrics: {
        totalCases: cases.length,
        correctSuggestionStates,
        suggestionStateAccuracy: correctSuggestionStates / cases.length,
        actionableTruePositives,
        actionableFalsePositives,
        actionableFalseNegatives,
        actionableSuggestionPrecision:
          precisionDenominator === 0
            ? 1
            : actionableTruePositives / precisionDenominator,
        actionableSuggestionRecall:
          recallDenominator === 0
            ? 1
            : actionableTruePositives / recallDenominator,
        minimalSetsCorrect,
        minimalSetAccuracy:
          minimalCases.length === 0
            ? 1
            : minimalSetsCorrect / minimalCases.length,
        falseActionable: actionableFalsePositives,
        falseUnavailable: cases.filter(
          ({ expectedState, actualState }) =>
            expectedState !== "unavailable" && actualState === "unavailable",
        ).length,
        deterministicSuggestionIds: cases.filter(
          ({ deterministicSuggestionId }) => deterministicSuggestionId,
        ).length,
        deterministicSymbolOrders: cases.filter(
          ({ deterministicSymbolOrder }) => deterministicSymbolOrder,
        ).length,
        originalExecutorLaunchesPrevented: cases.filter(
          ({ originalExecutorLaunchPrevented }) =>
            originalExecutorLaunchPrevented,
        ).length,
        revisedProposalsSuccessfullyReachingReadiness: cases.filter(
          ({ revisedProposalReachedReadiness }) =>
            revisedProposalReachedReadiness,
        ).length,
        mainCheckoutMutations: cases.filter(
          ({ mainCheckoutMutated }) => mainCheckoutMutated,
        ).length,
        unauthorizedScopeAccepted: cases.filter(
          ({ unauthorizedScopeAccepted }) => unauthorizedScopeAccepted,
        ).length,
      },
      regressions,
      warnings: [],
    };
  };

export const proposalRepairSuggestionBenchmarkConsoleReport = (
  report: ProposalRepairSuggestionBenchmarkReport,
): string =>
  `${[
    `${report.suiteId}@${report.suiteVersion} (${report.cases.length} cases)`,
    ...report.cases.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.actualState}`,
    ),
    `Suggestion-state accuracy: ${report.metrics.correctSuggestionStates}/${report.metrics.totalCases}`,
    `Actionable precision: ${report.metrics.actionableSuggestionPrecision.toFixed(3)}`,
    `Actionable recall: ${report.metrics.actionableSuggestionRecall.toFixed(3)}`,
    `Minimal-set accuracy: ${report.metrics.minimalSetAccuracy.toFixed(3)}`,
    `False actionable: ${report.metrics.falseActionable}`,
    `False unavailable: ${report.metrics.falseUnavailable}`,
    `Deterministic suggestion IDs: ${report.metrics.deterministicSuggestionIds}/${report.metrics.totalCases}`,
    `Deterministic symbol orders: ${report.metrics.deterministicSymbolOrders}/${report.metrics.totalCases}`,
    `Original executor launches prevented: ${report.metrics.originalExecutorLaunchesPrevented}`,
    `Revised proposals reaching readiness: ${report.metrics.revisedProposalsSuccessfullyReachingReadiness}`,
    `Main-checkout mutations: ${report.metrics.mainCheckoutMutations}`,
    `Unauthorized scope accepted: ${report.metrics.unauthorizedScopeAccepted}`,
    `Regressions: ${report.regressions.length}`,
  ].join("\n")}\n`;
