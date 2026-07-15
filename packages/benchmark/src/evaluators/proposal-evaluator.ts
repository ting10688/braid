import path from "node:path";
import type {
  MigrationProposal,
  ProposalEvidence,
  ReversibilityAssessment,
  RiskAssessment,
} from "@braid/core";
import type {
  ExpectationFile,
  Flakiness,
  IssueExpectation,
  ProposalCaseResult,
} from "../models/benchmark.js";
import { timingSummary } from "../runner/command-runner.js";
import type { IndependentFacts } from "./static-analysis.js";

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  [...left].sort().join("\0") === [...right].sort().join("\0");

const acceptedSet = (
  actual: readonly string[],
  acceptable: readonly (readonly string[])[] | undefined,
): boolean =>
  !acceptable || acceptable.some((candidate) => sameSet(actual, candidate));

const independentlyConnectedCycle = (
  modules: readonly string[],
  facts: IndependentFacts,
): boolean => {
  if (modules.length < 2) return false;
  const selected = new Set(modules);
  const adjacency = new Map(
    modules.map((module) => [module, new Set<string>()]),
  );
  for (const edge of facts.imports)
    if (
      edge.kind === "internal" &&
      selected.has(edge.fromModule) &&
      selected.has(edge.toModule) &&
      edge.fromModule !== edge.toModule
    )
      adjacency.get(edge.fromModule)?.add(edge.toModule);
  return modules.every((start) => {
    const reached = new Set([start]);
    const pending = [start];
    while (pending.length > 0)
      for (const target of adjacency.get(pending.pop()!) ?? [])
        if (!reached.has(target)) {
          reached.add(target);
          pending.push(target);
        }
    return modules.every((module) => reached.has(module));
  });
};

interface ProposalAction {
  key: string;
  proposal: MigrationProposal;
  proposalIndex: number;
  affectedFiles: string[];
  affectedModules: string[];
  evidence: ProposalEvidence[];
  risk: RiskAssessment;
  reversibility: ReversibilityAssessment;
  selectedEdge?: { fromModule: string; toModule: string };
  candidateSymbols?: string[];
}

const proposalActions = (
  proposal: MigrationProposal,
  proposalIndex: number,
  includeAlternatives: boolean,
): ProposalAction[] => {
  const primary: ProposalAction = {
    key: `${proposalIndex}:primary`,
    proposal,
    proposalIndex,
    affectedFiles: proposal.affectedFiles,
    affectedModules: proposal.affectedModules,
    evidence: proposal.evidence,
    risk: proposal.risk,
    reversibility: proposal.reversibility,
    ...(proposal.target.type === "extract-module"
      ? { candidateSymbols: proposal.target.candidateSymbols }
      : { selectedEdge: proposal.target.selectedEdge }),
  };
  if (!includeAlternatives || proposal.type !== "break-cycle") return [primary];
  return [
    primary,
    ...(proposal.alternatives ?? []).map(
      (alternative, alternativeIndex): ProposalAction => ({
        key: `${proposalIndex}:alternative:${alternativeIndex}`,
        proposal,
        proposalIndex,
        affectedFiles: alternative.affectedFiles,
        affectedModules: alternative.affectedModules,
        evidence: alternative.evidence,
        risk: alternative.risk,
        reversibility: alternative.reversibility,
        selectedEdge: alternative.selectedEdge,
      }),
    ),
  ];
};

const actionMatchesExpectation = (
  action: ProposalAction,
  expected: IssueExpectation,
): boolean => {
  if (action.proposal.type !== expected.type) return false;
  if (
    expected.maximumAffectedFiles !== undefined &&
    action.affectedFiles.length > expected.maximumAffectedFiles
  )
    return false;
  if (!acceptedSet(action.affectedFiles, expected.acceptableFiles))
    return false;
  if (!acceptedSet(action.affectedModules, expected.acceptableModules))
    return false;
  if (action.proposal.type === "extract-module")
    return acceptedSet(
      action.candidateSymbols ?? [],
      expected.acceptableSymbols,
    );
  const selectedEdge = action.selectedEdge;
  return (
    selectedEdge !== undefined &&
    (!expected.acceptableCycleEdges ||
      expected.acceptableCycleEdges.some(
        (edge) =>
          edge.fromModule === selectedEdge.fromModule &&
          edge.toModule === selectedEdge.toModule,
      ))
  );
};

export const proposalMatchesExpectation = (
  proposal: MigrationProposal,
  expected: IssueExpectation,
): boolean =>
  proposalActions(proposal, 0, true).some((action) =>
    actionMatchesExpectation(action, expected),
  );

interface Match {
  expectation: IssueExpectation;
  proposal: MigrationProposal;
  proposalIndex: number;
  action: ProposalAction;
}

export const matchProposals = (
  proposals: readonly MigrationProposal[],
  expectations: readonly IssueExpectation[],
  includeAlternatives = false,
): {
  matches: Match[];
  unmatched: IssueExpectation[];
  unexpected: MigrationProposal[];
} => {
  const used = new Set<string>();
  const matches: Match[] = [];
  const unmatched: IssueExpectation[] = [];
  const actions = proposals.flatMap((proposal, index) =>
    proposalActions(proposal, index, includeAlternatives),
  );
  for (const expectation of expectations) {
    const action = actions.find(
      (candidate) =>
        !used.has(candidate.key) &&
        actionMatchesExpectation(candidate, expectation),
    );
    if (!action) unmatched.push(expectation);
    else {
      used.add(action.key);
      matches.push({
        expectation,
        proposal: action.proposal,
        proposalIndex: action.proposalIndex,
        action,
      });
    }
  }
  const matchedProposalIndexes = new Set(
    matches.map(({ proposalIndex }) => proposalIndex),
  );
  return {
    matches,
    unmatched,
    unexpected: proposals.filter(
      (_, index) => !matchedProposalIndexes.has(index),
    ),
  };
};

const evidenceCorrect = (
  evidence: ProposalEvidence,
  facts: IndependentFacts,
): boolean => {
  switch (evidence.type) {
    case "oversized-file":
      return (
        facts.files.get(evidence.file)?.lines === evidence.actualLines &&
        evidence.thresholdLines === facts.config.thresholds.oversized_file_lines
      );
    case "oversized-module": {
      const actual = facts.moduleMetrics.get(evidence.module);
      return (
        actual?.files === evidence.actualFiles &&
        actual.exports === evidence.actualExports &&
        evidence.fileThreshold ===
          facts.config.thresholds.oversized_module_files &&
        evidence.exportThreshold ===
          facts.config.thresholds.oversized_module_exports
      );
    }
    case "dependency-cycle":
      return (
        independentlyConnectedCycle(evidence.modules, facts) &&
        evidence.files.every((file) => facts.files.has(file))
      );
    case "cycle-edge": {
      const imports = facts.imports.filter(
        (edge) =>
          edge.kind === "internal" &&
          edge.fromModule === evidence.fromModule &&
          edge.toModule === evidence.toModule,
      );
      return (
        imports.length === evidence.importCount &&
        sameSet(
          [...new Set(imports.map((edge) => edge.fromFile))],
          evidence.importingFiles,
        )
      );
    }
    case "symbol-cluster": {
      const source = facts.files.get(evidence.sourceFile)?.contents;
      return (
        source !== undefined &&
        evidence.symbols.every((symbol) =>
          new RegExp(
            `\\b(?:const|let|var|function|class|interface|type|enum)\\s+${symbol}\\b`,
            "u",
          ).test(source),
        ) &&
        evidence.sharedTokens.every((token) =>
          evidence.symbols.every((symbol) =>
            symbol.toLowerCase().includes(token.toLowerCase()),
          ),
        )
      );
    }
    case "public-entrypoint-impact":
      return evidence.files.every(
        (file) => facts.files.has(file) && /(?:^|\/)index\.tsx?$/u.test(file),
      );
    case "protected-path-impact":
      return evidence.files.every(
        (file) =>
          facts.files.has(file) &&
          facts.config.protected_paths.some((pattern) =>
            path.matchesGlob(file, pattern),
          ),
      );
    case "architecture-constraint":
      return (
        evidence.constraint === "circular_dependencies" &&
        evidence.details.includes(
          facts.config.constraints.circular_dependencies,
        )
      );
  }
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const normalizedDeterminism = (
  proposals: readonly MigrationProposal[],
): string =>
  JSON.stringify(
    proposals.map((proposal) => ({
      id: proposal.id,
      evidence: proposal.evidence,
      alternatives: proposal.alternatives,
      ranking: proposal.ranking,
    })),
  );

export interface ProposalEvaluationInput {
  caseId: string;
  expectation: ExpectationFile;
  proposalRuns: readonly (readonly MigrationProposal[])[];
  durations: readonly number[];
  facts: IndependentFacts;
  persistenceIdempotent: boolean;
  sourceMutations: readonly string[];
  flakiness: Flakiness;
  exitCodes: readonly number[];
  expectedExitCode: number;
}

export const evaluateProposalCase = (
  input: ProposalEvaluationInput,
): ProposalCaseResult => {
  const proposals = [...(input.proposalRuns[0] ?? [])];
  const matched = matchProposals(proposals, input.expectation.issues, true);
  const reviewed = matchProposals(
    matched.unexpected,
    input.expectation.reviewedProposals ?? [],
  );
  const reviewClassification = new Map(
    (input.expectation.reviewedProposals ?? []).map(
      ({ id, classification }) => [id, classification],
    ),
  );
  const reviewedIds = (
    classification: "rejected" | "ambiguous" | "informational",
  ) =>
    reviewed.matches
      .filter(
        ({ expectation }) =>
          reviewClassification.get(expectation.id) === classification,
      )
      .map(({ proposal }) => proposal.id);
  const rejectedProposalIds = reviewedIds("rejected");
  const ambiguousProposalIds = reviewedIds("ambiguous");
  const informationalProposalIds = reviewedIds("informational");
  const acceptedProposalIds = [
    ...new Set(matched.matches.map(({ proposal }) => proposal.id)),
  ];
  const requiredEvidence = matched.matches.flatMap(
    ({ expectation }) => expectation.requiredEvidenceTypes,
  );
  const presentEvidence = matched.matches.reduce(
    (total, { expectation, action }) =>
      total +
      expectation.requiredEvidenceTypes.filter((type) =>
        action.evidence.some((evidence) => evidence.type === type),
      ).length,
    0,
  );
  const evidence = matched.matches.flatMap(({ action }) => action.evidence);
  const ranked = matched.matches.filter(
    ({ expectation }) => expectation.ranking,
  );
  const risk = matched.matches.filter(
    ({ expectation }) => expectation.expectedRisk,
  );
  const reversibility = matched.matches.filter(
    ({ expectation }) => expectation.expectedReversibility,
  );
  const deterministic =
    !input.flakiness.flaky &&
    input.proposalRuns
      .map(normalizedDeterminism)
      .every((value, _, values) => value === values[0]);

  return {
    type: "proposal",
    caseId: input.caseId,
    expectedIssues: input.expectation.issues.length,
    proposals,
    matchedIssueIds: matched.matches.map(({ expectation }) => expectation.id),
    acceptedProposalIds,
    unmatchedIssueIds: matched.unmatched.map(({ id }) => id),
    unexpectedProposalIds: reviewed.unexpected.map(({ id }) => id),
    rejectedProposalIds,
    ambiguousProposalIds,
    informationalProposalIds,
    expectedIssueCoverage: ratio(
      matched.matches.length,
      input.expectation.issues.length,
    ),
    proposalValidity: ratio(
      matched.matches.length + informationalProposalIds.length,
      matched.matches.length +
        informationalProposalIds.length +
        reviewed.unexpected.length +
        rejectedProposalIds.length,
    ),
    topKCoverage: ratio(
      ranked.filter(
        ({ expectation, proposalIndex }) =>
          proposalIndex < expectation.ranking!.shouldAppearInTopK,
      ).length,
      ranked.length,
    ),
    evidenceCoverage: ratio(presentEvidence, requiredEvidence.length),
    evidenceCorrectness: ratio(
      evidence.filter((item) => evidenceCorrect(item, input.facts)).length,
      evidence.length,
    ),
    riskClassificationAgreement: ratio(
      risk.filter(({ expectation, action }) =>
        expectation.expectedRisk!.allowed.includes(action.risk.level),
      ).length,
      risk.length,
    ),
    reversibilityClassificationAgreement: ratio(
      reversibility.filter(({ expectation, action }) =>
        expectation.expectedReversibility!.allowed.includes(
          action.reversibility.level,
        ),
      ).length,
      reversibility.length,
    ),
    deterministic,
    flakiness: input.flakiness,
    proposalIdentityStable: !input.flakiness.differences.some(
      ({ field }) => field === "proposalIds",
    ),
    proposalOrderingStable: !input.flakiness.differences.some(
      ({ field }) => field === "proposalOrder",
    ),
    exitCodes: [...input.exitCodes],
    expectedExitCodeMatched: input.exitCodes.every(
      (exitCode) => exitCode === input.expectedExitCode,
    ),
    persistenceIdempotent: input.persistenceIdempotent,
    sourceMutations: [...input.sourceMutations],
    durations: timingSummary(input.durations),
    correctnessRepetitions: input.proposalRuns.length,
  };
};
