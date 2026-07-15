import path from "node:path";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  ScriptedTestExecutor,
  WorktreeManager,
  candidateBranchForExecution,
  captureMainCheckoutState,
  createExecutionPlan,
  hashNormalizedPatch,
  runMigration,
} from "@braid/migrator";
import {
  applyValidExtraction,
  createMigrationFixture,
} from "@braid/migrator/testing";
import { JsonExecutionStore } from "@braid/store";

export const MIGRATION_EXECUTION_SUITE_ID = "phase-3-execution";
export const MIGRATION_EXECUTION_SUITE_VERSION = "1.0.0";
export const MIGRATION_BENCHMARK_PROTOCOL_VERSION = "1.0.0";

const execFileAsync = promisify(execFile);

type CaseId =
  | "valid-notification-extraction"
  | "stale-proposal-rejection"
  | "wrong-approval-rejection"
  | "unauthorized-file-modification"
  | "dependency-modification"
  | "validation-failure"
  | "new-cycle-introduction"
  | "no-op-executor"
  | "executor-timeout"
  | "safe-discard";

interface CaseDefinition {
  id: CaseId;
  expectedStatus:
    | "succeeded"
    | "preflight-failed"
    | "scope-violation"
    | "validation-failed"
    | "needs-review"
    | "no-changes"
    | "executor-failed"
    | "discarded";
  safe: boolean;
  smoke: boolean;
  expectedExitCode?: number;
  expectedFailureCode?: string;
  expectedScopeViolationCode?: string;
}

const CASES: CaseDefinition[] = [
  {
    id: "valid-notification-extraction",
    expectedStatus: "succeeded",
    safe: true,
    smoke: true,
  },
  {
    id: "stale-proposal-rejection",
    expectedStatus: "preflight-failed",
    safe: false,
    smoke: false,
    expectedExitCode: 4,
    expectedFailureCode: "stale-proposal",
  },
  {
    id: "wrong-approval-rejection",
    expectedStatus: "preflight-failed",
    safe: false,
    smoke: true,
    expectedExitCode: 3,
    expectedFailureCode: "approval-mismatch",
  },
  {
    id: "unauthorized-file-modification",
    expectedStatus: "scope-violation",
    safe: false,
    smoke: true,
    expectedExitCode: 8,
    expectedFailureCode: "scope-violation",
    expectedScopeViolationCode: "unauthorized-path",
  },
  {
    id: "dependency-modification",
    expectedStatus: "scope-violation",
    safe: false,
    smoke: false,
    expectedExitCode: 8,
    expectedFailureCode: "scope-violation",
    expectedScopeViolationCode: "dependency-change",
  },
  {
    id: "validation-failure",
    expectedStatus: "validation-failed",
    safe: false,
    smoke: false,
    expectedExitCode: 9,
    expectedFailureCode: "required-validation-failed",
  },
  {
    id: "new-cycle-introduction",
    expectedStatus: "needs-review",
    safe: false,
    smoke: false,
    expectedExitCode: 10,
    expectedFailureCode: "architecture-validation-failed",
  },
  {
    id: "no-op-executor",
    expectedStatus: "no-changes",
    safe: false,
    smoke: false,
    expectedExitCode: 8,
    expectedFailureCode: "no-changes",
  },
  {
    id: "executor-timeout",
    expectedStatus: "executor-failed",
    safe: false,
    smoke: true,
    expectedExitCode: 7,
    expectedFailureCode: "executor-timeout",
  },
  {
    id: "safe-discard",
    expectedStatus: "discarded",
    safe: true,
    smoke: true,
  },
];

export interface MigrationBenchmarkCaseResult {
  id: CaseId;
  expectedStatus: CaseDefinition["expectedStatus"];
  actualStatus: string;
  passed: boolean;
  safe: boolean;
  exitCode?: number;
  deterministicPlan: boolean;
  mainCheckoutMutated: boolean;
  scopeViolationAccepted: boolean;
  worktreeIsolated: boolean;
  executionRecordComplete: boolean;
  validationPassed: boolean;
  candidateCommitCreated: boolean;
  predictedActualComparisonRecorded: boolean;
  failureCode?: string;
  scopeViolationCodes: string[];
  discardVerified: boolean;
  runtimeMs: number;
}

export interface MigrationBenchmarkReport {
  suiteId: typeof MIGRATION_EXECUTION_SUITE_ID;
  suiteVersion: typeof MIGRATION_EXECUTION_SUITE_VERSION;
  protocolVersion: typeof MIGRATION_BENCHMARK_PROTOCOL_VERSION;
  smoke: boolean;
  cases: MigrationBenchmarkCaseResult[];
  metrics: {
    totalCases: number;
    successfulSafeMigrations: number;
    rejectedUnsafeMigrations: number;
    preflightCorrect: number;
    scopeCompliantSafeMigrations: number;
    mainCheckoutMutations: number;
    scopeViolationsAccepted: number;
    validationSuccesses: number;
    candidateCommitsCreated: number;
    predictedActualComparisons: number;
    isolatedWorktrees: number;
    deterministicPlans: number;
    completeExecutionRecords: number;
    runtimeMs: number;
  };
  regressions: string[];
  warnings: string[];
}

const executionIdFor = (index: number): string =>
  `E-${(0xb0000000 + index).toString(16)}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

const runCase = async (
  definition: CaseDefinition,
  index: number,
): Promise<MigrationBenchmarkCaseResult> => {
  const started = performance.now();
  const container = await mkdtemp(path.join(tmpdir(), "braid-benchmark-p3-"));
  try {
    const fixture = await createMigrationFixture(container, {
      failingValidation: definition.id === "validation-failure",
    });
    const proposal =
      definition.id === "stale-proposal-rejection"
        ? { ...fixture.proposal, snapshotId: "S-stale-proposal" }
        : fixture.proposal;
    const executionId = executionIdFor(index);
    const store = new JsonExecutionStore(fixture.repositoryRoot);
    const manager = new WorktreeManager({
      repositoryRoot: fixture.repositoryRoot,
      executionRoot: fixture.executionRoot,
    });
    const deterministicPlanInput = {
      proposal,
      snapshot: fixture.snapshot,
      config: fixture.config,
      baseCommit: fixture.baseCommit,
      sourceFingerprint: fixture.snapshot.sourceFingerprint!,
      executor: { kind: "scripted-test" as const },
    };
    const deterministicPlan =
      JSON.stringify(createExecutionPlan(deterministicPlanInput)) ===
      JSON.stringify(createExecutionPlan(deterministicPlanInput));
    const expectedCandidateBranch = candidateBranchForExecution(executionId);
    const mainIntegrityOptions = {
      ownedCandidateRef: `refs/heads/${expectedCandidateBranch}`,
    } as const;
    const mainBefore = await captureMainCheckoutState(
      fixture.repositoryRoot,
      mainIntegrityOptions,
    );
    const executor = new ScriptedTestExecutor(async (_plan, context) => {
      switch (definition.id) {
        case "valid-notification-extraction":
        case "validation-failure":
        case "safe-discard":
          await applyValidExtraction(context.worktreePath);
          break;
        case "new-cycle-introduction":
          await applyValidExtraction(context.worktreePath, {
            introduceCycle: true,
          });
          break;
        case "unauthorized-file-modification":
          await writeFile(
            path.join(context.worktreePath, "README.md"),
            "unauthorized\n",
          );
          break;
        case "dependency-modification":
          await writeFile(
            path.join(context.worktreePath, "package-lock.json"),
            '{"lockfileVersion":3,"packages":{"":{"dependencies":{"unsafe":"1"}}}}\n',
          );
          break;
        default:
          break;
      }
      return {
        exitCode: 0,
        timedOut: definition.id === "executor-timeout",
        stdout: "",
        stderr: "",
        events: [],
      };
    });
    let exitCode: number | undefined;
    let candidateCommitCreated = false;
    let candidateCommitVerified = false;
    let discardVerified = definition.id !== "safe-discard";
    try {
      const result = await runMigration({
        repositoryRoot: fixture.repositoryRoot,
        proposal,
        snapshot: fixture.snapshot,
        config: fixture.config,
        approval:
          definition.id === "wrong-approval-rejection" ? "wrong" : proposal.id,
        executor: { kind: "scripted-test" },
        migrationExecutor: executor,
        executionId,
        executionStore: store,
        worktreeManager: manager,
        now: () => new Date("2026-07-15T00:02:00.000Z"),
      });
      if (result.record.candidateCommit && result.record.candidateBranch) {
        const [
          branchHead,
          parent,
          commitCount,
          message,
          committedPatch,
          paths,
        ] = await Promise.all([
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "rev-parse",
              result.record.candidateBranch,
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "rev-parse",
              `${result.record.candidateCommit}^`,
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "rev-list",
              "--count",
              `${fixture.baseCommit}..${result.record.candidateBranch}`,
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "show",
              "-s",
              "--format=%B",
              result.record.candidateCommit,
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "diff",
              fixture.baseCommit,
              result.record.candidateCommit,
              "--binary",
              "--no-ext-diff",
              "--no-color",
              "--unified=0",
              "--",
            ],
            { encoding: "utf8" },
          ),
          execFileAsync(
            "git",
            [
              "-C",
              fixture.repositoryRoot,
              "diff",
              "--name-only",
              "-z",
              fixture.baseCommit,
              result.record.candidateCommit,
              "--",
            ],
            { encoding: "utf8" },
          ),
        ]);
        const committedFiles = paths.stdout
          .split("\0")
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right));
        candidateCommitVerified =
          branchHead.stdout.trim() === result.record.candidateCommit &&
          commitCount.stdout.trim() === "1" &&
          parent.stdout.trim() === fixture.baseCommit &&
          message.stdout.includes(
            `Braid-Execution: ${result.record.executionId}`,
          ) &&
          message.stdout.includes(`Braid-Plan: ${result.record.planId}`) &&
          hashNormalizedPatch(committedPatch.stdout) ===
            result.record.fingerprints.diffHash &&
          JSON.stringify(committedFiles) ===
            JSON.stringify(result.record.scope.changedFiles);
        candidateCommitCreated =
          branchHead.stdout.trim() !== fixture.baseCommit;
      }
      if (definition.id === "safe-discard") {
        await manager.discard(executionId);
        const locator = await manager.load(executionId);
        const branch = await execFileAsync(
          "git",
          ["-C", fixture.repositoryRoot, "branch", "--list", locator.branch],
          { encoding: "utf8" },
        );
        const worktreeRemoved = await access(locator.worktreePath).then(
          () => false,
          () => true,
        );
        discardVerified =
          locator.discardedAt !== undefined &&
          branch.stdout.trim() === "" &&
          worktreeRemoved;
        await store.saveRecord({
          ...result.record,
          status: "discarded",
          completedAt: "2026-07-15T00:03:00.000Z",
        });
      }
    } catch (error) {
      exitCode =
        error !== null &&
        typeof error === "object" &&
        "exitCode" in error &&
        typeof error.exitCode === "number"
          ? error.exitCode
          : 1;
    }
    const record = await store.loadRecord(executionId);
    const plan = await store.loadPlan(executionId);
    if (!candidateCommitCreated) {
      const actualCandidateHead = await execFileAsync(
        "git",
        [
          "-C",
          fixture.repositoryRoot,
          "show-ref",
          "--verify",
          "--hash",
          `refs/heads/${candidateBranchForExecution(executionId)}`,
        ],
        { encoding: "utf8" },
      ).then(
        ({ stdout }) => stdout.trim(),
        () => "",
      );
      candidateCommitCreated =
        actualCandidateHead !== "" &&
        actualCandidateHead !== fixture.baseCommit;
      if (!candidateCommitCreated && record.candidateBranch) {
        const locator = await manager.load(executionId);
        const currentReflog = await execFileAsync(
          "git",
          [
            "-C",
            fixture.repositoryRoot,
            "reflog",
            "show",
            "--format=%H%x00%gs",
            record.candidateBranch,
          ],
          { encoding: "utf8" },
        ).then(
          ({ stdout }) => stdout.trim(),
          () => "",
        );
        candidateCommitCreated = currentReflog !== locator.initialReflog;
      }
    }
    const ownedWorktreeGitDirectory =
      record.candidateBranch && record.status !== "discarded"
        ? await manager.gitDirectory(executionId)
        : undefined;
    const mainAfter = await captureMainCheckoutState(fixture.repositoryRoot, {
      ...mainIntegrityOptions,
      ...(ownedWorktreeGitDirectory ? { ownedWorktreeGitDirectory } : {}),
    });
    const executionRefs = (
      await execFileAsync(
        "git",
        [
          "-C",
          fixture.repositoryRoot,
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/braid/exec",
        ],
        { encoding: "utf8" },
      )
    ).stdout
      .split("\n")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    const expectedExecutionRefs =
      record.candidateBranch && record.status !== "discarded"
        ? [`refs/heads/${record.candidateBranch}`]
        : [];
    const sharedRefsSafe =
      JSON.stringify(executionRefs) === JSON.stringify(expectedExecutionRefs);
    let worktreeIsolated = true;
    if (record.candidateBranch) {
      const owned = await manager.load(executionId);
      const relative = path.relative(
        fixture.repositoryRoot,
        owned.worktreePath,
      );
      worktreeIsolated =
        relative.startsWith("..") && !path.isAbsolute(relative);
    }
    const mainCheckoutMutated =
      mainBefore.fingerprint !== mainAfter.fingerprint ||
      !mainAfter.clean ||
      !sharedRefsSafe;
    const expectedValidationEvidence = plan.validation.commands
      .map(({ id, stage, required }) => ({ commandId: id, stage, required }))
      .sort((left, right) => left.commandId.localeCompare(right.commandId));
    const actualValidationEvidence = record.validation
      .map(({ commandId, stage, required }) => ({
        commandId,
        stage,
        required,
      }))
      .sort((left, right) => left.commandId.localeCompare(right.commandId));
    const executionRecordComplete =
      plan.planId === record.planId &&
      record.completedAt !== undefined &&
      record.fingerprints.mainAfter !== undefined &&
      (!definition.safe ||
        isDeepStrictEqual(
          expectedValidationEvidence,
          actualValidationEvidence,
        )) &&
      !JSON.stringify({ plan, record }).includes(container);
    const actualStatus = record.status;
    const failureCode = record.failure?.code;
    const scopeViolationCodes = record.scope.violations.map(
      (violation) => violation.code,
    );
    const validationPassed =
      record.validation.length > 0 &&
      record.validation.every(
        (validation) => !validation.required || validation.status === "passed",
      );
    const predictedActualComparisonRecorded =
      record.architecture.comparison !== undefined;
    const patchArtifact = record.artifacts.patch
      ? await readFile(
          path.join(fixture.repositoryRoot, record.artifacts.patch),
          "utf8",
        ).catch(() => "")
      : "";
    const validationArtifact = record.artifacts.validationReport
      ? await readFile(
          path.join(fixture.repositoryRoot, record.artifacts.validationReport),
          "utf8",
        )
          .then((contents) => JSON.parse(contents) as unknown)
          .catch(() => undefined)
      : undefined;
    const validationArtifactMatches =
      validationArtifact !== undefined &&
      typeof validationArtifact === "object" &&
      validationArtifact !== null &&
      "results" in validationArtifact &&
      isDeepStrictEqual(validationArtifact.results, record.validation);
    const executionDirectory = path.join(
      fixture.repositoryRoot,
      ".braid",
      "executions",
      executionId,
    );
    const architectureArtifactsExist = (
      await Promise.all(
        [
          "architecture-before.json",
          "architecture-after.json",
          "impact-comparison.json",
        ].map((name) =>
          access(path.join(executionDirectory, name)).then(
            () => true,
            () => false,
          ),
        ),
      )
    ).every(Boolean);
    const eventArtifactExists = record.artifacts.eventLog
      ? await access(
          path.join(fixture.repositoryRoot, record.artifacts.eventLog),
        ).then(
          () => true,
          () => false,
        )
      : false;
    const scopeViolationAccepted =
      ["unauthorized-file-modification", "dependency-modification"].includes(
        definition.id,
      ) && actualStatus === "succeeded";
    const expectedExitObserved =
      definition.expectedExitCode === undefined
        ? exitCode === undefined
        : exitCode === definition.expectedExitCode;
    const expectedFailureObserved =
      definition.expectedFailureCode === undefined
        ? failureCode === undefined
        : failureCode === definition.expectedFailureCode;
    const expectedScopeViolationObserved =
      definition.expectedScopeViolationCode === undefined ||
      scopeViolationCodes.some(
        (code) => code === definition.expectedScopeViolationCode,
      );
    const expectedArchitectureEvidence =
      definition.id !== "new-cycle-introduction" ||
      ((record.architecture.actualImpact?.newCycles ?? 0) > 0 &&
        record.failure?.message.includes("new-cycle-introduced") === true);
    const successfulArtifactsComplete =
      !definition.safe ||
      (validationPassed &&
        candidateCommitVerified &&
        predictedActualComparisonRecorded &&
        patchArtifact !== "" &&
        hashNormalizedPatch(patchArtifact) === record.fingerprints.diffHash &&
        validationArtifactMatches &&
        eventArtifactExists &&
        architectureArtifactsExist);
    const unsafeCaseHasNoCandidateCommit =
      definition.safe || !candidateCommitCreated;
    return {
      id: definition.id,
      expectedStatus: definition.expectedStatus,
      actualStatus,
      passed:
        actualStatus === definition.expectedStatus &&
        !mainCheckoutMutated &&
        !scopeViolationAccepted &&
        worktreeIsolated &&
        executionRecordComplete &&
        deterministicPlan &&
        expectedExitObserved &&
        expectedFailureObserved &&
        expectedScopeViolationObserved &&
        expectedArchitectureEvidence &&
        successfulArtifactsComplete &&
        unsafeCaseHasNoCandidateCommit &&
        discardVerified,
      safe: definition.safe,
      ...(exitCode === undefined ? {} : { exitCode }),
      deterministicPlan,
      mainCheckoutMutated,
      scopeViolationAccepted,
      worktreeIsolated,
      executionRecordComplete,
      validationPassed,
      candidateCommitCreated,
      predictedActualComparisonRecorded,
      ...(failureCode ? { failureCode } : {}),
      scopeViolationCodes,
      discardVerified,
      runtimeMs: Math.round(performance.now() - started),
    };
  } finally {
    await rm(container, { recursive: true, force: true });
  }
};

export const runMigrationExecutionBenchmark = async (
  options: { smoke?: boolean } = {},
): Promise<MigrationBenchmarkReport> => {
  const smoke = options.smoke ?? false;
  const definitions = smoke ? CASES.filter(({ smoke }) => smoke) : CASES;
  const cases: MigrationBenchmarkCaseResult[] = [];
  for (const [index, definition] of definitions.entries())
    cases.push(await runCase(definition, index));
  const regressions = cases
    .filter((item) => !item.passed)
    .map(
      (item) =>
        `${item.id}: expected ${item.expectedStatus}, got ${item.actualStatus}${item.failureCode ? ` (${item.failureCode})` : ""}`,
    );
  if (cases.some(({ mainCheckoutMutated }) => mainCheckoutMutated))
    regressions.push("main-checkout mutation > 0");
  if (cases.some(({ scopeViolationAccepted }) => scopeViolationAccepted))
    regressions.push("scope violation accepted");
  if (cases.some(({ executionRecordComplete }) => !executionRecordComplete))
    regressions.push("missing execution record");
  if (cases.some(({ deterministicPlan }) => !deterministicPlan))
    regressions.push("nondeterministic execution plan");
  if (
    cases.some(
      ({ safe, candidateCommitCreated }) => !safe && candidateCommitCreated,
    )
  )
    regressions.push("unsafe execution created a candidate commit");
  if (cases.some(({ discardVerified }) => !discardVerified))
    regressions.push("safe discard did not remove its owned Git resources");
  const unsafe = cases.filter(({ safe }) => !safe);
  return {
    suiteId: MIGRATION_EXECUTION_SUITE_ID,
    suiteVersion: MIGRATION_EXECUTION_SUITE_VERSION,
    protocolVersion: MIGRATION_BENCHMARK_PROTOCOL_VERSION,
    smoke,
    cases,
    metrics: {
      totalCases: cases.length,
      successfulSafeMigrations: cases.filter(
        ({ safe, passed }) => safe && passed,
      ).length,
      rejectedUnsafeMigrations: unsafe.filter(({ passed }) => passed).length,
      preflightCorrect: cases.filter(
        ({ id, passed }) =>
          ["stale-proposal-rejection", "wrong-approval-rejection"].includes(
            id,
          ) && passed,
      ).length,
      scopeCompliantSafeMigrations: cases.filter(
        ({ safe, passed, scopeViolationAccepted }) =>
          safe && passed && !scopeViolationAccepted,
      ).length,
      mainCheckoutMutations: cases.filter(
        ({ mainCheckoutMutated }) => mainCheckoutMutated,
      ).length,
      scopeViolationsAccepted: cases.filter(
        ({ scopeViolationAccepted }) => scopeViolationAccepted,
      ).length,
      validationSuccesses: cases.filter(({ validationPassed }) =>
        Boolean(validationPassed),
      ).length,
      candidateCommitsCreated: cases.filter(
        ({ candidateCommitCreated }) => candidateCommitCreated,
      ).length,
      predictedActualComparisons: cases.filter(
        ({ predictedActualComparisonRecorded }) =>
          predictedActualComparisonRecorded,
      ).length,
      isolatedWorktrees: cases.filter(
        ({ worktreeIsolated }) => worktreeIsolated,
      ).length,
      deterministicPlans: cases.filter(
        ({ deterministicPlan }) => deterministicPlan,
      ).length,
      completeExecutionRecords: cases.filter(
        ({ executionRecordComplete }) => executionRecordComplete,
      ).length,
      runtimeMs: cases.reduce((total, item) => total + item.runtimeMs, 0),
    },
    regressions: [...new Set(regressions)],
    warnings: [],
  };
};

export const migrationBenchmarkConsoleReport = (
  report: MigrationBenchmarkReport,
): string =>
  `${[
    `${report.suiteId}@${report.suiteVersion} (${report.cases.length} cases)`,
    ...report.cases.map(
      (item) =>
        `${item.passed ? "PASS" : "FAIL"} ${item.id}: ${item.actualStatus} (${item.runtimeMs}ms)`,
    ),
    `Safe migrations: ${report.metrics.successfulSafeMigrations}`,
    `Unsafe rejections: ${report.metrics.rejectedUnsafeMigrations}`,
    `Main-checkout mutations: ${report.metrics.mainCheckoutMutations}`,
    `Scope violations accepted: ${report.metrics.scopeViolationsAccepted}`,
    `Deterministic plans: ${report.metrics.deterministicPlans}/${report.metrics.totalCases}`,
    `Complete records: ${report.metrics.completeExecutionRecords}/${report.metrics.totalCases}`,
    `Regressions: ${report.regressions.length}`,
    `Warnings: ${report.warnings.length}`,
  ].join("\n")}\n`;
