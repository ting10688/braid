import { migrationProposalSchema } from "@braid/core";
import { z } from "zod";

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const commandSchema = z.array(z.string().min(1)).min(1);
const percentSchema = z.number().finite().nonnegative();
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);

export const canonicalGitHubUrlSchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u);

export const repositoryCommandSchema = z.object({
  executable: z.string().min(1),
  arguments: z.array(z.string().min(1)),
});

export const qualificationStatusSchema = z.enum([
  "qualified",
  "qualified-with-limitations",
  "rejected",
]);

const recordedCommandStatusSchema = z.object({
  status: z.enum(["passed", "failed", "excluded"]),
  command: z.string().min(1),
  detail: z.string().min(1),
});

export const repositoryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  title: z.string().min(1),
  role: z.enum(["control", "complexity"]),
  repository: z.object({
    url: canonicalGitHubUrlSchema,
    commit: commitShaSchema,
  }),
  license: z.object({
    spdxId: z.literal("MIT"),
    file: z.string().min(1),
    contentHash: sha256Schema,
    attribution: z.string().min(1),
  }),
  packageManager: z.object({
    name: z.enum(["npm", "pnpm"]),
    version: z.string().min(1),
    lockfile: z.string().min(1),
    lockfileHash: sha256Schema,
  }),
  environment: z.object({
    node: z.string().min(1),
    networkRequiredAfterCheckout: z.literal(false),
  }),
  source: z.object({
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)),
    tests: z.array(z.string().min(1)).min(1),
    testExclude: z.array(z.string().min(1)).default([]),
    manifestHash: sha256Schema,
    fileCount: z.number().int().nonnegative(),
    testFileCount: z.number().int().nonnegative(),
    linesOfCode: z.number().int().nonnegative(),
    moduleCount: z.number().int().nonnegative(),
    preferredRange: z.enum(["below", "within", "above"]),
    largestFiles: z.array(
      z.object({
        path: z.string().min(1),
        linesOfCode: z.number().int().positive(),
      }),
    ),
  }),
  braidConfiguration: z.object({
    file: z.string().min(1),
    hash: sha256Schema,
  }),
  commands: z.object({
    install: repositoryCommandSchema,
    build: repositoryCommandSchema,
    test: repositoryCommandSchema,
  }),
  qualification: z.object({
    status: qualificationStatusSchema,
    reviewedAt: z.string().date(),
    install: recordedCommandStatusSchema,
    build: recordedCommandStatusSchema,
    test: recordedCommandStatusSchema,
    braidAnalysis: recordedCommandStatusSchema,
    limitations: z.array(z.string().min(1)),
  }),
});

export const normalizationRuleSchema = z.enum([
  "run-ids",
  "timestamps",
  "temporary-directory-paths",
  "timing-samples",
  "generated-state-paths",
]);

export const benchmarkProtocolSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: versionSchema,
  correctnessRepetitions: z.number().int().min(2),
  timingRepetitions: z.number().int().positive(),
  warmupRuns: z.number().int().nonnegative(),
  defaultTimeoutMs: z.number().int().positive(),
  normalizationRules: z.array(normalizationRuleSchema).min(1),
});

export const issueExpectationSchema = z.object({
  id: idSchema,
  type: z.enum(["extract-module", "break-cycle"]),
  acceptableFiles: z.array(z.array(z.string().min(1)).min(1)).optional(),
  acceptableModules: z.array(z.array(z.string().min(1)).min(1)).optional(),
  acceptableSymbols: z.array(z.array(z.string().min(1)).min(2)).optional(),
  acceptableCycleEdges: z
    .array(
      z.object({
        fromModule: z.string().min(1),
        toModule: z.string().min(1),
      }),
    )
    .optional(),
  maximumAffectedFiles: z.number().int().positive().optional(),
  requiredEvidenceTypes: z.array(z.string().min(1)),
  expectedRisk: z
    .object({ allowed: z.array(z.enum(["low", "medium", "high"])).min(1) })
    .optional(),
  expectedReversibility: z
    .object({
      allowed: z.array(z.enum(["easy", "conditional", "difficult"])).min(1),
    })
    .optional(),
  ranking: z
    .object({ shouldAppearInTopK: z.number().int().positive() })
    .optional(),
  notes: z.string().min(1),
});

export const expectationFileSchema = z.object({
  schemaVersion: z.literal(1),
  version: versionSchema,
  issues: z.array(issueExpectationSchema),
  reviewedProposals: z
    .array(
      issueExpectationSchema.extend({
        classification: z.enum(["rejected", "ambiguous", "informational"]),
      }),
    )
    .default([]),
});

export const proposalBenchmarkCaseSchema = z.object({
  type: z.literal("proposal"),
  id: idSchema,
  fixture: z.string().min(1),
  expectationFile: z.string().min(1),
  braidCommands: z.object({
    init: commandSchema,
    analyze: commandSchema,
    propose: commandSchema,
  }),
  expectedExitCode: z.number().int().min(0).max(255),
  smoke: z.boolean().default(false),
});

export const repositoryProposalBenchmarkCaseSchema = z.object({
  type: z.literal("repository-proposal"),
  id: idSchema,
  repositoryId: idSchema,
  expectationFile: z.string().min(1),
  braidCommands: z.object({
    init: commandSchema,
    analyze: commandSchema,
    propose: commandSchema,
  }),
  expectedExitCode: z.number().int().min(0).max(255),
  smoke: z.boolean().default(false),
});

export const staticComparisonCaseSchema = z.object({
  type: z.literal("static-comparison"),
  id: idSchema,
  beforeFixture: z.string().min(1),
  afterFixture: z.string().min(1),
  commands: z.object({
    build: commandSchema.optional(),
    test: commandSchema.optional(),
    runtimeBenchmark: commandSchema.optional(),
  }),
  artifacts: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
  tolerances: z
    .object({
      buildDurationRegressionPercent: percentSchema.optional(),
      testDurationRegressionPercent: percentSchema.optional(),
      artifactSizeRegressionPercent: percentSchema.optional(),
    })
    .optional(),
  smoke: z.boolean().default(false),
});

export const realWorldRepositorySchema = z.object({
  repositoryUrl: z.string().url(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
  license: z.object({
    spdxId: z.string().min(1),
    reviewed: z.boolean(),
  }),
  localCacheKey: z.string().min(1),
  setupCommands: z.array(commandSchema),
  buildCommands: z.array(commandSchema),
  testCommands: z.array(commandSchema),
});

export const repositorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixture"), fixture: z.string().min(1) }),
  z.object({
    kind: z.literal("real-world"),
    repository: realWorldRepositorySchema,
  }),
]);

export const changeTaskBenchmarkCaseSchema = z.object({
  type: z.literal("change-task"),
  id: idSchema,
  source: repositorySourceSchema,
  taskPrompt: z.string().min(1),
  allowedFiles: z.array(z.string().min(1)),
  forbiddenFiles: z.array(z.string().min(1)),
  setupCommand: commandSchema.optional(),
  validationCommands: z.array(commandSchema).min(1),
  architectureBudgets: z.record(z.number().finite()),
  timeoutMs: z.number().int().positive(),
  maximumAttempts: z.number().int().positive(),
  expectedBehavior: z.array(z.string().min(1)).min(1),
});

export const rollbackBenchmarkCaseSchema = z.object({
  type: z.literal("rollback"),
  id: idSchema,
  fixture: z.string().min(1),
  migrationProposalId: z.string().min(1),
  validationCommands: z.array(commandSchema).min(1),
  expectedDependentMigrations: z.array(z.string().min(1)),
  expectedRestoredTreeHashPolicy: z.enum(["exact", "allowed-differences"]),
  allowedGeneratedStateDifferences: z.array(z.string().min(1)),
});

export const changeTaskResultSchema = z.object({
  type: z.literal("change-task"),
  caseId: idSchema,
  taskSuccess: z.boolean(),
  filesTouched: z.number().int().nonnegative(),
  modulesTouched: z.number().int().nonnegative(),
  sourceDiffLines: z.number().int().nonnegative(),
  testFilesChanged: z.number().int().nonnegative(),
  testCommandAttempts: z.number().int().nonnegative(),
  failedValidationAttempts: z.number().int().nonnegative(),
  agentIterations: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  elapsedMs: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  architectureViolationsIntroduced: z.number().int().nonnegative(),
  architectureBudgetCompliant: z.boolean(),
});

export const rollbackResultSchema = z.object({
  type: z.literal("rollback"),
  caseId: idSchema,
  directRollbackSuccess: z.boolean(),
  postRollbackBuildSuccess: z.boolean(),
  postRollbackTestSuccess: z.boolean(),
  sourceTreeRestorationMatch: z.boolean(),
  allowedGeneratedStateDifferences: z.array(z.string()),
  dependentMigrationDetection: z.boolean(),
  rollbackDurationMs: z.number().finite().nonnegative(),
});

export const benchmarkCaseSchema = z.discriminatedUnion("type", [
  proposalBenchmarkCaseSchema,
  repositoryProposalBenchmarkCaseSchema,
  staticComparisonCaseSchema,
  changeTaskBenchmarkCaseSchema,
  rollbackBenchmarkCaseSchema,
]);

export const benchmarkSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  suiteVersion: versionSchema,
  expectationVersion: z.string().min(1),
  id: idSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  cases: z.array(benchmarkCaseSchema).min(1),
  execution: z
    .object({
      correctnessRepetitions: z.number().int().min(2).optional(),
      timingRepetitions: z.number().int().positive().optional(),
      warmupRuns: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .default({}),
});

export const fixtureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  manifestVersion: versionSchema,
  suiteId: idSchema,
  suiteVersion: versionSchema,
  fixtures: z.array(
    z.object({
      fixtureId: z.string().min(1),
      files: z.array(
        z.object({
          path: z.string().min(1),
          contentHash: sha256Schema,
        }),
      ),
      configurationHash: sha256Schema,
      expectationFileHash: sha256Schema,
    }),
  ),
  hash: sha256Schema,
});

export const runManifestSchema = z.object({
  schemaVersion: z.literal(1),
  protocolVersion: versionSchema,
  suiteId: idSchema,
  suiteVersion: versionSchema,
  expectationVersion: z.string().min(1),
  fixtureManifestVersion: versionSchema,
  fixtureManifestHash: sha256Schema,
  configurationHash: sha256Schema,
  repositories: z
    .array(
      z.object({
        id: idSchema,
        url: canonicalGitHubUrlSchema,
        commit: commitShaSchema,
        licenseHash: sha256Schema,
        lockfileHash: sha256Schema,
        sourceManifestHash: sha256Schema,
        braidConfigurationHash: sha256Schema,
        qualificationStatus: qualificationStatusSchema,
        sourceFiles: z.number().int().nonnegative(),
        sourceLinesOfCode: z.number().int().nonnegative(),
        moduleCount: z.number().int().nonnegative(),
        installStatus: z.enum(["passed", "failed", "excluded"]),
        buildStatus: z.enum(["passed", "failed", "excluded"]),
        testStatus: z.enum(["passed", "failed", "excluded"]),
        braidAnalysisStatus: z.enum(["passed", "failed", "excluded"]),
      }),
    )
    .optional(),
  braidVersion: z.string().min(1),
  braidCommit: z.string().min(1).nullable(),
  benchmarkVersion: z.string().min(1),
  benchmarkCommit: z.string().min(1).nullable(),
  environment: z.object({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    nodeVersion: z.string().min(1),
    pnpmVersion: z.string().min(1),
    gitVersion: z.string().min(1),
  }),
  execution: z.object({
    correctnessRepetitions: z.number().int().min(2),
    timingRepetitions: z.number().int().positive(),
    warmupRuns: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
    command: z.string().min(1),
  }),
});

export const timingSummarySchema = z.object({
  medianMs: z.number().finite().nonnegative(),
  minimumMs: z.number().finite().nonnegative(),
  maximumMs: z.number().finite().nonnegative(),
  repetitions: z.number().int().positive(),
});

export const commandMeasurementSchema = z.object({
  exitCodes: z.array(z.number().int()),
  timing: timingSummarySchema,
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  passingTests: z.number().int().nonnegative().nullable(),
  failingTests: z.number().int().nonnegative().nullable(),
});

export const architectureMeasurementSchema = z.object({
  sourceFiles: z.number().int().nonnegative(),
  sourceLinesOfCode: z.number().int().nonnegative(),
  modules: z.number().int().nonnegative(),
  internalImports: z.number().int().nonnegative(),
  externalImports: z.number().int().nonnegative(),
  crossModuleImports: z.number().int().nonnegative(),
  circularDependencies: z.number().int().nonnegative(),
  oversizedFiles: z.number().int().nonnegative(),
  oversizedModules: z.number().int().nonnegative(),
  publicEntrypoints: z.number().int().nonnegative(),
});

export const architectureDeltaSchema = z.object({
  sourceFiles: z.number().int(),
  sourceLinesOfCode: z.number().int(),
  modules: z.number().int(),
  internalImports: z.number().int(),
  externalImports: z.number().int(),
  crossModuleImports: z.number().int(),
  circularDependencies: z.number().int(),
  oversizedFiles: z.number().int(),
  oversizedModules: z.number().int(),
  publicEntrypoints: z.number().int(),
});

export const flakinessSchema = z.object({
  flaky: z.boolean(),
  differences: z.array(
    z.object({
      field: z.string().min(1),
      repetitions: z.array(z.number().int().positive()).min(1),
    }),
  ),
});

export const proposalCaseResultSchema = z.object({
  type: z.literal("proposal"),
  caseId: idSchema,
  expectedIssues: z.number().int().nonnegative(),
  proposals: z.array(migrationProposalSchema),
  matchedIssueIds: z.array(idSchema),
  unmatchedIssueIds: z.array(idSchema),
  unexpectedProposalIds: z.array(z.string()),
  rejectedProposalIds: z.array(z.string()).optional(),
  ambiguousProposalIds: z.array(z.string()).optional(),
  informationalProposalIds: z.array(z.string()).optional(),
  expectedIssueCoverage: z.number().min(0).max(1),
  proposalValidity: z.number().min(0).max(1),
  topKCoverage: z.number().min(0).max(1),
  evidenceCoverage: z.number().min(0).max(1),
  evidenceCorrectness: z.number().min(0).max(1),
  riskClassificationAgreement: z.number().min(0).max(1),
  reversibilityClassificationAgreement: z.number().min(0).max(1),
  deterministic: z.boolean(),
  flakiness: flakinessSchema,
  proposalIdentityStable: z.boolean(),
  proposalOrderingStable: z.boolean(),
  exitCodes: z.array(z.number().int()).min(2),
  expectedExitCodeMatched: z.boolean(),
  persistenceIdempotent: z.boolean(),
  sourceMutations: z.array(z.string()),
  durations: timingSummarySchema,
  correctnessRepetitions: z.number().int().min(2),
  setupDurationMs: z.number().finite().nonnegative().optional(),
});

export const toleranceResultSchema = z.object({
  metric: z.enum(["buildDuration", "testDuration", "artifactSize"]),
  regressionPercent: z.number().finite().nullable(),
  tolerancePercent: z.number().finite().nonnegative(),
  withinTolerance: z.boolean(),
});

export const staticComparisonResultSchema = z.object({
  type: z.literal("static-comparison"),
  caseId: idSchema,
  before: z.object({
    architecture: architectureMeasurementSchema,
    build: commandMeasurementSchema.nullable(),
    test: commandMeasurementSchema.nullable(),
    runtimeBenchmark: commandMeasurementSchema.nullable(),
    artifactSizeBytes: z.number().int().nonnegative().nullable(),
  }),
  after: z.object({
    architecture: architectureMeasurementSchema,
    build: commandMeasurementSchema.nullable(),
    test: commandMeasurementSchema.nullable(),
    runtimeBenchmark: commandMeasurementSchema.nullable(),
    artifactSizeBytes: z.number().int().nonnegative().nullable(),
  }),
  architectureDelta: architectureDeltaSchema,
  changeMagnitude: z.object({
    filesAdded: z.number().int().nonnegative(),
    filesRemoved: z.number().int().nonnegative(),
    filesModified: z.number().int().nonnegative(),
    sourceLineDelta: z.number().int(),
  }),
  behaviorValid: z.boolean(),
  tolerances: z.array(toleranceResultSchema),
  sourceMutations: z.array(z.string()),
  flakiness: flakinessSchema,
});

export const benchmarkCaseResultSchema = z.discriminatedUnion("type", [
  proposalCaseResultSchema,
  staticComparisonResultSchema,
]);

export const environmentFingerprintSchema = z.object({
  operatingSystem: z.string().min(1),
  architecture: z.string().min(1),
  nodeVersion: z.string().min(1),
  pnpmVersion: z.string().min(1),
  gitVersion: z.string().min(1),
  cpuModel: z.string().min(1).nullable(),
  logicalCpuCount: z.number().int().positive(),
  totalMemoryBytes: z.number().int().positive(),
});

export const benchmarkRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  suiteId: idSchema,
  suiteVersion: versionSchema,
  expectationVersion: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  braid: z.object({
    commit: z.string().min(1).nullable(),
    version: z.string().min(1),
    command: z.string().min(1),
  }),
  benchmark: z.object({
    commit: z.string().min(1).nullable(),
    version: z.string().min(1),
  }),
  environment: environmentFingerprintSchema,
  manifest: runManifestSchema,
  fixtureManifest: fixtureManifestSchema,
  cases: z.array(benchmarkCaseResultSchema),
});

export const policyRuleSchema = z.union([
  z.object({ direction: z.enum(["nondecreasing", "nonincreasing"]) }).strict(),
  z.object({ maximum: z.number().finite() }).strict(),
  z.object({ allowedRegressionPercent: percentSchema }).strict(),
  z.object({ allowedIncreasePercent: percentSchema }).strict(),
  z
    .object({ requiredValue: z.union([z.number(), z.boolean(), z.string()]) })
    .strict(),
]);

const policyRulesSchema = z.union([
  policyRuleSchema,
  z.array(policyRuleSchema).min(1),
]);

export const regressionPolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: versionSchema,
  blocking: z.record(policyRulesSchema),
  warnings: z.record(policyRulesSchema),
});

export const comparisonStatusSchema = z.enum([
  "improved",
  "regressed",
  "unchanged",
  "warning",
  "incompatible",
]);

const metricValueSchema = z.union([z.number(), z.boolean(), z.string()]);

export const metricComparisonSchema = z.object({
  metric: z.string().min(1),
  category: z.enum(["correctness", "stability", "cost"]),
  baseline: metricValueSchema,
  candidate: metricValueSchema,
  status: comparisonStatusSchema,
  rationale: z.string().min(1),
});

const comparisonRunDescriptorSchema = z.object({
  runId: z.string().min(1),
  braidVersion: z.string().min(1),
  braidCommit: z.string().min(1).nullable(),
  manifest: runManifestSchema,
});

export const iterationComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: versionSchema,
  baselineRunId: z.string().min(1),
  candidateRunId: z.string().min(1),
  baseline: comparisonRunDescriptorSchema,
  candidate: comparisonRunDescriptorSchema,
  compatible: z.boolean(),
  incompatibilities: z.array(z.string()),
  environmentWarnings: z.array(z.string()),
  comparisons: z.array(metricComparisonSchema),
  overallResult: z.enum(["pass", "fail", "warning", "incompatible"]),
});

export const benchmarkSummarySchema = z.object({
  correctness: z.record(metricValueSchema),
  stability: z.record(metricValueSchema),
  cost: z.record(metricValueSchema),
});

export const goldenBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  name: idSchema,
  createdFromRunId: z.string().min(1),
  manifest: runManifestSchema,
  summary: benchmarkSummarySchema,
  braid: z.object({
    version: z.string().min(1),
    commit: z.string().min(1).nullable(),
  }),
  benchmark: z.object({
    version: z.string().min(1),
    commit: z.string().min(1).nullable(),
  }),
});

export const benchmarkBaselineSchema = goldenBaselineSchema;

export type IssueExpectation = z.infer<typeof issueExpectationSchema>;
export type BenchmarkProtocol = z.infer<typeof benchmarkProtocolSchema>;
export type ExpectationFile = z.infer<typeof expectationFileSchema>;
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;
export type RepositoryCommand = z.infer<typeof repositoryCommandSchema>;
export type ProposalBenchmarkCase = z.infer<typeof proposalBenchmarkCaseSchema>;
export type RepositoryProposalBenchmarkCase = z.infer<
  typeof repositoryProposalBenchmarkCaseSchema
>;
export type StaticComparisonCase = z.infer<typeof staticComparisonCaseSchema>;
export type ChangeTaskBenchmarkCase = z.infer<
  typeof changeTaskBenchmarkCaseSchema
>;
export type RollbackBenchmarkCase = z.infer<typeof rollbackBenchmarkCaseSchema>;
export type RealWorldRepository = z.infer<typeof realWorldRepositorySchema>;
export type RepositorySource = z.infer<typeof repositorySourceSchema>;
export type ChangeTaskResult = z.infer<typeof changeTaskResultSchema>;
export type RollbackResult = z.infer<typeof rollbackResultSchema>;
export type BenchmarkBaseline = z.infer<typeof benchmarkBaselineSchema>;
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
export type RunManifest = z.infer<typeof runManifestSchema>;
export type Flakiness = z.infer<typeof flakinessSchema>;
export type RegressionPolicy = z.infer<typeof regressionPolicySchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;
export type MetricComparison = z.infer<typeof metricComparisonSchema>;
export type IterationComparison = z.infer<typeof iterationComparisonSchema>;
export type BenchmarkSummary = z.infer<typeof benchmarkSummarySchema>;
export type GoldenBaseline = z.infer<typeof goldenBaselineSchema>;
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;
export type BenchmarkCaseReference = BenchmarkCase;
export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;
export type TimingSummary = z.infer<typeof timingSummarySchema>;
export type CommandMeasurement = z.infer<typeof commandMeasurementSchema>;
export type ArchitectureMeasurement = z.infer<
  typeof architectureMeasurementSchema
>;
export type ProposalCaseResult = z.infer<typeof proposalCaseResultSchema>;
export type StaticComparisonResult = z.infer<
  typeof staticComparisonResultSchema
>;
export type BenchmarkCaseResult = z.infer<typeof benchmarkCaseResultSchema>;
export type EnvironmentFingerprint = z.infer<
  typeof environmentFingerprintSchema
>;
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;
