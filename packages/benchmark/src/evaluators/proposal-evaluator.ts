import path from "node:path";
import type { MigrationProposal, ProposalEvidence } from "@braid/core";
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

export const proposalMatchesExpectation = (
  proposal: MigrationProposal,
  expected: IssueExpectation,
): boolean => {
  if (proposal.type !== expected.type) return false;
  if (
    expected.maximumAffectedFiles !== undefined &&
    proposal.affectedFiles.length > expected.maximumAffectedFiles
  )
    return false;
  if (!acceptedSet(proposal.affectedFiles, expected.acceptableFiles))
    return false;
  if (!acceptedSet(proposal.affectedModules, expected.acceptableModules))
    return false;
  if (proposal.target.type === "extract-module")
    return acceptedSet(
      proposal.target.candidateSymbols,
      expected.acceptableSymbols,
    );
  const selectedEdge = proposal.target.selectedEdge;
  return (
    !expected.acceptableCycleEdges ||
    expected.acceptableCycleEdges.some(
      (edge) =>
        edge.fromModule === selectedEdge.fromModule &&
        edge.toModule === selectedEdge.toModule,
    )
  );
};

interface Match {
  expectation: IssueExpectation;
  proposal: MigrationProposal;
  proposalIndex: number;
}

export const matchProposals = (
  proposals: readonly MigrationProposal[],
  expectations: readonly IssueExpectation[],
): {
  matches: Match[];
  unmatched: IssueExpectation[];
  unexpected: MigrationProposal[];
} => {
  const used = new Set<number>();
  const matches: Match[] = [];
  const unmatched: IssueExpectation[] = [];
  for (const expectation of expectations) {
    const proposalIndex = proposals.findIndex(
      (proposal, index) =>
        !used.has(index) && proposalMatchesExpectation(proposal, expectation),
    );
    if (proposalIndex < 0) unmatched.push(expectation);
    else {
      used.add(proposalIndex);
      matches.push({
        expectation,
        proposal: proposals[proposalIndex]!,
        proposalIndex,
      });
    }
  }
  return {
    matches,
    unmatched,
    unexpected: proposals.filter((_, index) => !used.has(index)),
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
  const matched = matchProposals(proposals, input.expectation.issues);
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
  const requiredEvidence = matched.matches.flatMap(
    ({ expectation }) => expectation.requiredEvidenceTypes,
  );
  const presentEvidence = matched.matches.reduce(
    (total, { expectation, proposal }) =>
      total +
      expectation.requiredEvidenceTypes.filter((type) =>
        proposal.evidence.some((evidence) => evidence.type === type),
      ).length,
    0,
  );
  const evidence = matched.matches.flatMap(({ proposal }) => proposal.evidence);
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
      proposals.length - ambiguousProposalIds.length,
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
      risk.filter(({ expectation, proposal }) =>
        expectation.expectedRisk!.allowed.includes(proposal.risk.level),
      ).length,
      risk.length,
    ),
    reversibilityClassificationAgreement: ratio(
      reversibility.filter(({ expectation, proposal }) =>
        expectation.expectedReversibility!.allowed.includes(
          proposal.reversibility.level,
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
