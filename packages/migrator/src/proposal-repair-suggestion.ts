import { createHash } from "node:crypto";
import {
  migrationProposalSchema,
  proposalRepairSuggestionSchema,
  type ArchitectureSnapshot,
  type ExecutionReadinessResult,
  type ExecutionReadinessSymbol,
  type MigrationProposal,
  type ProposalRepairSafeImport,
  type ProposalRepairSuggestedAddition,
  type ProposalRepairSuggestion,
  type ProposalRepairSuggestionState,
  type ReadinessReason,
} from "@braid/core";
import { classifyModule } from "@braid/analyzer";
import {
  evaluateExecutionReadiness,
  type EvaluateExecutionReadinessInput,
} from "./execution-readiness.js";

export const REPAIR_SUGGESTION_ALGORITHM_VERSION = "1.0.0";

export type SuggestProposalRepairInput = EvaluateExecutionReadinessInput;

type SuggestionCore = Omit<
  ProposalRepairSuggestion,
  "suggestionId" | "deterministicEvidence"
>;

const compare = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;
const locatorKey = (value: { file: string; name: string }): string =>
  `${value.file}\0${value.name}`;
const symbolKey = (value: { file: string; name: string }): string =>
  locatorKey(value);

const canonical = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map(canonical).sort(compare).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const normalizeSemanticOrder = <T>(value: T): T => {
  if (Array.isArray(value))
    return value
      .map((item) => normalizeSemanticOrder(item))
      .sort((left, right) => compare(canonical(left), canonical(right))) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeSemanticOrder(item),
      ]),
    ) as T;
  return value;
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

const proposalFingerprint = (proposal: MigrationProposal): string =>
  sha256({
    ...proposal,
    snapshotId: "<linked-snapshot>",
  });

const snapshotFingerprint = (snapshot: ArchitectureSnapshot): string =>
  sha256({
    gitCommit: snapshot.gitCommit,
    configHash: snapshot.configHash,
    migrationConfigHash: snapshot.migrationConfigHash,
    sourceFingerprint: snapshot.sourceFingerprint,
    repository: {
      ...snapshot.repository,
      projectRoot: "<project-root>",
    },
    metrics: snapshot.metrics,
  });

const sortedSymbols = (
  symbols: readonly ExecutionReadinessSymbol[],
): ExecutionReadinessSymbol[] =>
  [...symbols].sort((left, right) =>
    compare(symbolKey(left), symbolKey(right)),
  );

const revisedProposal = (
  proposal: MigrationProposal,
  additions: readonly ExecutionReadinessSymbol[],
): MigrationProposal => {
  if (proposal.target.type !== "extract-module")
    throw new Error(
      "Proposal repair suggestions support extract-module proposals only",
    );
  const approved = new Map(
    (proposal.target.approvedCompanionSymbols ?? []).map((item) => [
      `${item.file}\0${item.symbol}`,
      item,
    ]),
  );
  for (const addition of additions)
    approved.set(symbolKey(addition), {
      file: addition.file,
      symbol: addition.name,
    });
  const approvedCompanionSymbols = [...approved.values()].sort((left, right) =>
    compare(`${left.file}\0${left.symbol}`, `${right.file}\0${right.symbol}`),
  );
  return migrationProposalSchema.parse({
    ...proposal,
    target: {
      ...proposal.target,
      ...(approvedCompanionSymbols.length > 0
        ? { approvedCompanionSymbols }
        : { approvedCompanionSymbols: undefined }),
    },
  });
};

const evaluateRevision = (
  input: SuggestProposalRepairInput,
  additions: readonly ExecutionReadinessSymbol[],
): ExecutionReadinessResult =>
  evaluateExecutionReadiness({
    ...input,
    proposal: revisedProposal(input.proposal, additions),
  });

const safeImportsFor = (
  readiness: ExecutionReadinessResult,
): ProposalRepairSafeImport[] =>
  [
    ...readiness.retainedDependencies.map((dependency) => ({
      kind: "internal" as const,
      dependency,
    })),
    ...readiness.externalDependencies.map((dependency) => ({
      kind: "external" as const,
      dependency,
    })),
  ].sort((left, right) => {
    const leftKey =
      left.kind === "internal"
        ? `internal\0${symbolKey(left.dependency.symbol)}`
        : `external\0${left.dependency.package}\0${left.dependency.name}`;
    const rightKey =
      right.kind === "internal"
        ? `internal\0${symbolKey(right.dependency.symbol)}`
        : `external\0${right.dependency.package}\0${right.dependency.name}`;
    return compare(leftKey, rightKey);
  });

const hardUnavailableCodes = new Set<ReadinessReason["code"]>([
  "primary-symbol-unresolved",
  "required-local-declaration-unresolved",
  "closure-file-budget-exceeded",
  "closure-symbol-budget-exceeded",
  "protected-companion",
  "public-entrypoint-companion",
  "nondeterministic-closure",
]);

const hasUnrepairableEvidence = (
  readiness: ExecutionReadinessResult,
): boolean =>
  readiness.blockingReasons.some(({ code }) =>
    hardUnavailableCodes.has(code),
  ) ||
  readiness.warnings.some(({ code }) => code === "legacy-reference-evidence");

const omissionAddition = (
  input: SuggestProposalRepairInput,
  selected: readonly ExecutionReadinessSymbol[],
  symbol: ExecutionReadinessSymbol,
): ProposalRepairSuggestedAddition => {
  const omission = evaluateRevision(
    input,
    selected.filter((candidate) => symbolKey(candidate) !== symbolKey(symbol)),
  );
  const codes = omission.blockingReasons.map(({ code }) => code).sort(compare);
  return {
    symbol,
    rationale: `Required by deterministic symbol closure; omitting ${symbol.file}#${symbol.name} leaves readiness ${omission.state}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}.`,
    omissionReadinessState: omission.state,
    omissionBlockingReasons: omission.blockingReasons,
  };
};

const commonCore = (
  input: SuggestProposalRepairInput,
  current: ExecutionReadinessResult,
) => ({
  schemaVersion: "1.0.0" as const,
  baseProposalId: input.proposal.id as `P-EM-${string}`,
  fingerprints: {
    baseProposal: proposalFingerprint(input.proposal),
    snapshot: snapshotFingerprint(input.snapshot),
    configuration: input.configHash,
    source: input.sourceFingerprint,
  },
  currentReadinessState: current.state,
  primarySymbols: sortedSymbols(current.primarySymbols),
  currentApprovedCompanionSymbols:
    input.proposal.target.type === "extract-module"
      ? (input.proposal.target.approvedCompanionSymbols ?? [])
          .map(({ file, symbol }) => ({ file, name: symbol }))
          .sort((left, right) => compare(locatorKey(left), locatorKey(right)))
      : [],
  advisory: true as const,
});

const unavailableCore = (
  input: SuggestProposalRepairInput,
  current: ExecutionReadinessResult,
): SuggestionCore => ({
  ...commonCore(input, current),
  state: "unavailable",
  predictedReadinessState: null,
  suggestedCompanionSymbolAdditions: [],
  minimization: { candidateSymbols: [], eliminatedSymbols: [] },
  retainedDependencies: current.retainedDependencies,
  safelyImportedDependencies: safeImportsFor(current),
  unresolvedDependencies: current.unresolvedDependencies,
  predictedImportEdges: current.predictedImportEdges,
  predictedCycleRisks: current.predictedCycleRisks,
  remainingBlockers: current.blockingReasons,
  warnings: current.warnings,
  reevaluation: { performed: false, resultHash: null, stable: false },
  minimal: false,
});

const actionableCandidates = (
  input: SuggestProposalRepairInput,
  candidates: readonly ExecutionReadinessSymbol[],
  requiredKeys: ReadonlySet<string>,
): {
  selected: ExecutionReadinessSymbol[];
  predicted: ExecutionReadinessResult;
  eliminated: ExecutionReadinessSymbol[];
} => {
  let selected = sortedSymbols(
    candidates.filter((candidate) => requiredKeys.has(symbolKey(candidate))),
  );
  let predicted = evaluateRevision(input, selected);
  const eliminated =
    predicted.state === "not-ready"
      ? []
      : candidates.filter(
          (candidate) => !requiredKeys.has(symbolKey(candidate)),
        );

  for (const candidate of [...selected]) {
    const trial = selected.filter(
      (symbol) => symbolKey(symbol) !== symbolKey(candidate),
    );
    const trialReadiness = evaluateRevision(input, trial);
    if (trialReadiness.state !== "not-ready") {
      selected = trial;
      predicted = trialReadiness;
      eliminated.push(candidate);
    }
  }
  return { selected, predicted, eliminated: sortedSymbols(eliminated) };
};

const possibleCompanionCandidates = (
  input: SuggestProposalRepairInput,
  excludedKeys: ReadonlySet<string>,
): ExecutionReadinessSymbol[] => {
  if (input.proposal.target.type !== "extract-module") return [];
  const target = input.proposal.target;
  const moduleByFile = new Map(
    input.snapshot.repository.modules.flatMap((module) =>
      module.paths.map((file) => [file, module.id] as const),
    ),
  );
  const remainingCapacity = Math.max(
    0,
    input.config.migration.maximumSymbols - excludedKeys.size,
  );
  const source = input.snapshot.repository.files.find(
    ({ path }) => path === target.sourceFile,
  );
  return sortedSymbols(
    (source?.declarations ?? []).flatMap((declaration) => {
      const symbol: ExecutionReadinessSymbol = {
        file: target.sourceFile,
        name: declaration.name,
        kind: declaration.kind,
        module:
          moduleByFile.get(target.sourceFile) ??
          classifyModule(target.sourceFile),
        exported: declaration.exported,
      };
      return excludedKeys.has(symbolKey(symbol)) ? [] : [symbol];
    }),
  ).slice(0, remainingCapacity);
};

const suggestionCoreFor = (
  input: SuggestProposalRepairInput,
  current: ExecutionReadinessResult,
): SuggestionCore => {
  if (
    input.proposal.target.type !== "extract-module" ||
    current.state !== "not-ready" ||
    hasUnrepairableEvidence(current)
  )
    return unavailableCore(input, current);

  const approved = new Set(
    (input.proposal.target.approvedCompanionSymbols ?? []).map(
      ({ file, symbol }) => `${file}\0${symbol}`,
    ),
  );
  const requiredCandidates = sortedSymbols(
    current.requiredCompanionSymbols.filter(
      (symbol) => !approved.has(symbolKey(symbol)),
    ),
  );
  if (requiredCandidates.length === 0) return unavailableCore(input, current);

  const excludedKeys = new Set([
    ...current.primarySymbols.map(symbolKey),
    ...current.requiredCompanionSymbols.map(symbolKey),
    ...approved,
  ]);
  const possibleCandidates = possibleCompanionCandidates(input, excludedKeys);
  const candidates = sortedSymbols([
    ...requiredCandidates,
    ...possibleCandidates,
  ]);
  const requiredKeys = new Set(requiredCandidates.map(symbolKey));

  const { selected, predicted, eliminated } = actionableCandidates(
    input,
    candidates,
    requiredKeys,
  );
  const state: ProposalRepairSuggestionState =
    predicted.state === "not-ready" ? "partial" : "actionable";
  if (selected.length === 0) return unavailableCore(input, current);
  return {
    ...commonCore(input, current),
    state,
    predictedReadinessState: predicted.state,
    suggestedCompanionSymbolAdditions: selected.map((symbol) =>
      omissionAddition(input, selected, symbol),
    ),
    minimization: {
      candidateSymbols: (state === "actionable"
        ? candidates
        : requiredCandidates
      ).map(({ file, name }) => ({ file, name })),
      eliminatedSymbols: eliminated.map(({ file, name }) => ({ file, name })),
    },
    retainedDependencies: predicted.retainedDependencies,
    safelyImportedDependencies: safeImportsFor(predicted),
    unresolvedDependencies: predicted.unresolvedDependencies,
    predictedImportEdges: predicted.predictedImportEdges,
    predictedCycleRisks: predicted.predictedCycleRisks,
    remainingBlockers: predicted.blockingReasons,
    warnings: predicted.warnings,
    reevaluation: {
      performed: true,
      resultHash: sha256({
        ...predicted,
        deterministicEvidence: undefined,
      }),
      stable: predicted.deterministicEvidence.stable,
    },
    minimal: state === "actionable",
  };
};

export const suggestProposalRepair = (
  input: SuggestProposalRepairInput,
): ProposalRepairSuggestion => {
  const current = evaluateExecutionReadiness(input);
  const first = normalizeSemanticOrder(suggestionCoreFor(input, current));
  const repeated = normalizeSemanticOrder(suggestionCoreFor(input, current));
  const semanticHash = sha256(first);
  const repeatedSemanticHash = sha256(repeated);
  const stable = semanticHash === repeatedSemanticHash;
  const core = stable
    ? first
    : normalizeSemanticOrder(unavailableCore(input, current));
  return proposalRepairSuggestionSchema.parse({
    ...core,
    suggestionId: `RS-${sha256(core).slice(0, 16)}`,
    deterministicEvidence: {
      algorithmVersion: REPAIR_SUGGESTION_ALGORITHM_VERSION,
      semanticHash,
      repeatedSemanticHash,
      stable,
    },
  });
};
