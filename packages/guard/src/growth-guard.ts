import path from "node:path";
import { analyzeRepository } from "@braid/analyzer";
import {
  growthModeConfigHash,
  growthModeReportSchema,
  loadArchitectureConfig,
  type ArchitectureConfig,
  type GrowthModeCurrentIdentity,
  type GrowthModeReport,
} from "@braid/core";
import { CONFIG_FILE } from "@braid/shared";
import {
  prefixedId,
  portableRepository,
  reportId,
  repositoryArchitectureFingerprint,
  sha256,
} from "./canonical.js";
import { compareGrowth, sanitizeAnalysisWarning } from "./comparison.js";
import {
  CLI_ADAPTER_COMPATIBILITY,
  type GrowthGuardLifecycle,
  type GrowthGuardOptions,
  type GrowthModeCheckResult,
  type GrowthModeFinalResult,
} from "./contracts.js";
import { formatGrowthContext, formatGrowthFeedback } from "./formatter.js";
import {
  captureGitState,
  changedManifestPaths,
  resolveGitContext,
  type GitStateCapture,
} from "./git-state.js";
import {
  GrowthStateStore,
  type GrowthBaselineCapture,
  type GrowthSessionState,
} from "./state-store.js";

interface Runtime {
  config: ArchitectureConfig;
  capture: GitStateCapture;
  store: GrowthStateStore;
}

interface BaselineRuntime extends Runtime {
  state: GrowthSessionState;
  initialized: boolean;
}

interface Evaluation extends BaselineRuntime {
  report: GrowthModeReport;
  noChange: boolean;
}

const blockingFingerprint = (report: GrowthModeReport): string | null => {
  const blocking = report.findings
    .filter(({ severity }) => severity === "block")
    .map(({ id }) => id)
    .sort();
  return blocking.length === 0
    ? null
    : sha256({ diffFingerprint: report.diffFingerprint, blocking });
};

export const createGrowthGuard = (
  options: GrowthGuardOptions,
): GrowthGuardLifecycle => {
  const projectRoot = path.resolve(options.projectRoot);
  const now = options.now ?? (() => new Date());
  const compatibility = options.compatibility ?? CLI_ADAPTER_COMPATIBILITY;

  const runtime = async (): Promise<Runtime> => {
    const [context, config] = await Promise.all([
      resolveGitContext(projectRoot),
      loadArchitectureConfig(path.join(projectRoot, CONFIG_FILE)),
    ]);
    const capture = await captureGitState(
      context,
      config,
      growthModeConfigHash(config),
    );
    return {
      config,
      capture,
      store: new GrowthStateStore(
        capture.gitDirectory,
        options.sessionId,
        capture.repository,
      ),
    };
  };

  const makeReport = (input: Omit<GrowthModeReport, "id">): GrowthModeReport =>
    growthModeReportSchema.parse({ ...input, id: reportId(input) });

  const currentIdentity = (
    capture: GitStateCapture,
    architectureFingerprint: string,
  ): GrowthModeCurrentIdentity => ({
    head: capture.head,
    gitFingerprint: capture.gitFingerprint,
    sourceFingerprint: capture.sourceFingerprint,
    architectureFingerprint,
  });

  const reportFor = (
    baseline: GrowthBaselineCapture,
    capture: GitStateCapture,
    current: GrowthModeCurrentIdentity,
    config: ArchitectureConfig,
    changedPaths: string[],
    comparison: ReturnType<typeof compareGrowth>,
    analysisDurationMs: number,
    skippedReason: GrowthModeReport["skippedReason"],
    cacheHit: boolean,
  ): GrowthModeReport => {
    const diffFingerprint = sha256({
      baseline: baseline.identity.id,
      head: current.head,
      sourceFingerprint: current.sourceFingerprint,
      architectureFingerprint: current.architectureFingerprint,
      configFingerprint: capture.configFingerprint,
      indexFingerprint: capture.indexFingerprint,
      changedPaths,
    });
    return makeReport({
      schemaVersion: "1.0.0",
      sessionId: options.sessionId,
      repository: capture.repository,
      baseline: baseline.identity,
      current,
      diffFingerprint,
      changedPaths,
      affectedPaths: comparison.affectedPaths,
      status: comparison.status,
      findings: comparison.findings,
      skippedReason,
      cacheHit,
      generatedAt: now().toISOString(),
      compatibility,
      statistics: {
        noChangeSkip: skippedReason === "no-relevant-change",
        analysisDurationMs,
        changedFileCount: changedPaths.length,
        affectedFileCount: comparison.affectedPaths.length,
      },
    });
  };

  const ensureBaseline = async (): Promise<BaselineRuntime> => {
    const currentRuntime = await runtime();
    const existing = await currentRuntime.store.load();
    if (existing)
      return { ...currentRuntime, state: existing, initialized: false };

    const started = Date.now();
    const analysis = await analyzeRepository(
      projectRoot,
      currentRuntime.config,
    );
    const architectureFingerprint = repositoryArchitectureFingerprint(
      analysis.repository,
      analysis.metrics,
      analysis.warnings,
    );
    const identityContent = {
      gitFingerprint: currentRuntime.capture.gitFingerprint,
      sourceFingerprint: currentRuntime.capture.sourceFingerprint,
      architectureFingerprint,
      configFingerprint: currentRuntime.capture.configFingerprint,
    };
    const baseline: GrowthBaselineCapture = {
      identity: {
        id: prefixedId("GB", identityContent),
        ...identityContent,
      },
      head: currentRuntime.capture.head,
      sourceManifest: currentRuntime.capture.sourceManifest,
      repository: portableRepository(analysis.repository),
      metrics: analysis.metrics,
      warnings: analysis.warnings.map((warning) =>
        sanitizeAnalysisWarning(warning, analysis.repository.projectRoot),
      ),
      thresholds: currentRuntime.config.thresholds,
    };
    const comparison = currentRuntime.config.growthMode.enabled
      ? compareGrowth({
          baseline,
          current: analysis,
          config: currentRuntime.config,
          changedPaths: [],
        })
      : { status: "pass" as const, findings: [], affectedPaths: [] };
    const report = reportFor(
      baseline,
      currentRuntime.capture,
      currentIdentity(currentRuntime.capture, architectureFingerprint),
      currentRuntime.config,
      [],
      comparison,
      Date.now() - started,
      currentRuntime.config.growthMode.enabled
        ? "baseline-initialized"
        : "growth-mode-disabled",
      false,
    );
    const state: GrowthSessionState = {
      schemaVersion: 1,
      repository: currentRuntime.capture.repository,
      baseline,
      lastEvaluationFingerprint: currentRuntime.capture.gitFingerprint,
      latestReport: report,
      stop: {
        fingerprint: blockingFingerprint(report),
        attempts: 0,
        unresolvedCompletion: false,
      },
    };
    await currentRuntime.store.save(state);
    return { ...currentRuntime, state, initialized: true };
  };

  const noChangeReport = (
    state: GrowthSessionState,
    config: ArchitectureConfig,
  ): GrowthModeReport => {
    const source = state.latestReport;
    const { id: _id, ...content } = source;
    void _id;
    return makeReport({
      ...content,
      compatibility,
      skippedReason: config.growthMode.enabled
        ? "no-relevant-change"
        : "growth-mode-disabled",
      cacheHit: true,
      generatedAt: now().toISOString(),
      statistics: {
        ...source.statistics,
        noChangeSkip: true,
        analysisDurationMs: 0,
      },
    });
  };

  const evaluate = async (): Promise<Evaluation> => {
    const baselineRuntime = await ensureBaseline();
    if (baselineRuntime.initialized)
      return {
        ...baselineRuntime,
        report: baselineRuntime.state.latestReport,
        noChange: false,
      };
    if (
      baselineRuntime.capture.gitFingerprint ===
      baselineRuntime.state.lastEvaluationFingerprint
    )
      return {
        ...baselineRuntime,
        report: noChangeReport(baselineRuntime.state, baselineRuntime.config),
        noChange: true,
      };

    const started = Date.now();
    const analysis = await analyzeRepository(
      projectRoot,
      baselineRuntime.config,
    );
    const architectureFingerprint = repositoryArchitectureFingerprint(
      analysis.repository,
      analysis.metrics,
      analysis.warnings,
    );
    const changedPaths = changedManifestPaths(
      baselineRuntime.state.baseline.sourceManifest,
      baselineRuntime.capture.sourceManifest,
    );
    const comparison = baselineRuntime.config.growthMode.enabled
      ? compareGrowth({
          baseline: baselineRuntime.state.baseline,
          current: analysis,
          config: baselineRuntime.config,
          changedPaths,
        })
      : { status: "pass" as const, findings: [], affectedPaths: changedPaths };
    const report = reportFor(
      baselineRuntime.state.baseline,
      baselineRuntime.capture,
      currentIdentity(baselineRuntime.capture, architectureFingerprint),
      baselineRuntime.config,
      changedPaths,
      comparison,
      Date.now() - started,
      baselineRuntime.config.growthMode.enabled ? null : "growth-mode-disabled",
      false,
    );
    const nextBlockingFingerprint = blockingFingerprint(report);
    const stop =
      nextBlockingFingerprint === baselineRuntime.state.stop.fingerprint
        ? baselineRuntime.state.stop
        : {
            fingerprint: nextBlockingFingerprint,
            attempts: 0,
            unresolvedCompletion: false,
          };
    const state: GrowthSessionState = {
      ...baselineRuntime.state,
      lastEvaluationFingerprint: baselineRuntime.capture.gitFingerprint,
      latestReport: report,
      stop,
    };
    await baselineRuntime.store.save(state);
    return {
      ...baselineRuntime,
      state,
      report,
      noChange: false,
    };
  };

  const check = async (): Promise<GrowthModeCheckResult> => {
    const result = await evaluate();
    const feedback =
      result.noChange || result.report.findings.length === 0
        ? null
        : formatGrowthFeedback(
            result.report,
            result.config.growthMode.maxFeedbackCharacters,
          );
    return { report: result.report, feedback };
  };

  const final = async (): Promise<GrowthModeFinalResult> => {
    const result = await evaluate();
    const fingerprint = blockingFingerprint(result.report);
    let attempts = fingerprint === null ? 0 : result.state.stop.attempts;
    const shouldBlock =
      fingerprint !== null &&
      attempts < result.config.growthMode.stopBlocksPerFingerprint;
    if (shouldBlock) attempts += 1;
    const unresolvedCompletion = fingerprint !== null && !shouldBlock;
    const state: GrowthSessionState = {
      ...result.state,
      stop: {
        fingerprint,
        attempts,
        unresolvedCompletion,
      },
    };
    await result.store.save(state);
    return {
      report: result.report,
      feedback:
        result.report.findings.length === 0
          ? null
          : formatGrowthFeedback(
              result.report,
              result.config.growthMode.maxFeedbackCharacters,
            ),
      shouldBlock,
      unresolvedCompletion,
      stopAttemptsForFingerprint: attempts,
    };
  };

  return {
    async context() {
      const result = await ensureBaseline();
      return {
        report: result.state.latestReport,
        text: formatGrowthContext(
          result.state.latestReport,
          result.config.growthMode.maxFeedbackCharacters,
          {
            cycles: result.state.baseline.repository.cycles.length,
            oversizedModules: result.state.baseline.metrics.oversizedModules,
            analyzerWarnings: result.state.baseline.warnings.length,
          },
        ),
        initialized: result.initialized,
      };
    },
    check,
    final,
    async status() {
      const [context, config] = await Promise.all([
        resolveGitContext(projectRoot),
        loadArchitectureConfig(path.join(projectRoot, CONFIG_FILE)),
      ]);
      const store = new GrowthStateStore(
        context.gitDirectory,
        options.sessionId,
        context.repository,
      );
      const state = await store.load();
      return {
        enabled: config.growthMode.enabled,
        sessionId: options.sessionId,
        baselineExists: state !== null,
        baseline: state?.baseline.identity ?? null,
        current: state?.latestReport.current ?? null,
        latestReport: state?.latestReport ?? null,
        unresolvedCompletion: state?.stop.unresolvedCompletion ?? false,
      };
    },
    async reset() {
      const context = await resolveGitContext(projectRoot);
      return new GrowthStateStore(
        context.gitDirectory,
        options.sessionId,
        context.repository,
      ).reset();
    },
  };
};
