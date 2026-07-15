import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { migrationProposalSchema } from "@braid/core";
import {
  analyzeFixture,
  type IndependentFacts,
} from "../src/evaluators/static-analysis.js";
import {
  evaluateProposalCase,
  matchProposals,
  proposalMatchesExpectation,
} from "../src/evaluators/proposal-evaluator.js";
import type {
  ExpectationFile,
  IssueExpectation,
} from "../src/models/benchmark.js";
import { extractionProposal } from "./proposal-fixture.js";

const fixture = fileURLToPath(
  new URL(
    "../../../benchmarks/fixtures/templates/oversized-notifications",
    import.meta.url,
  ),
);
let facts: IndependentFacts;

beforeAll(async () => {
  facts = await analyzeFixture(fixture);
});

const expected = (
  overrides: Partial<IssueExpectation> = {},
): IssueExpectation => ({
  id: "notification-cluster",
  type: "extract-module",
  acceptableFiles: [["src/modules/orders/service.ts"]],
  acceptableModules: [["modules/orders"]],
  acceptableSymbols: [
    [
      "formatNotification",
      "notificationLog",
      "retryNotification",
      "sendNotification",
    ],
  ],
  requiredEvidenceTypes: ["oversized-file", "symbol-cluster"],
  expectedRisk: { allowed: ["low"] },
  expectedReversibility: { allowed: ["easy"] },
  ranking: { shouldAppearInTopK: 1 },
  notes: "Human-authored expected issue.",
  ...overrides,
});

const evaluate = (
  proposals = [extractionProposal()],
  expectation: ExpectationFile = {
    schemaVersion: 1,
    version: "v1",
    issues: [expected()],
  },
) =>
  evaluateProposalCase({
    caseId: "case",
    expectation,
    proposalRuns: [proposals, proposals],
    durations: [10, 12],
    facts,
    persistenceIdempotent: true,
    sourceMutations: [],
    flakiness: { flaky: false, differences: [] },
    exitCodes: [0, 0],
    expectedExitCode: 0,
  });

const groupedCycleProposal = () =>
  migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-BC-12345678",
    snapshotId: "S-example",
    type: "break-cycle",
    title: "Grouped cycle root",
    summary: "One primary with an alternative.",
    affectedFiles: ["src/a.ts", "src/b.ts"],
    affectedModules: ["a", "b"],
    target: {
      type: "break-cycle",
      cycleModules: ["a", "b"],
      cycleFiles: ["src/a.ts", "src/b.ts"],
      selectedEdge: {
        fromModule: "a",
        toModule: "b",
        files: ["src/a.ts", "src/b.ts"],
      },
      suggestedStrategy: "introduce-boundary",
      rootCauseSignature: "CR-123456789abc",
      rootCauseModules: ["a", "b"],
    },
    evidence: [
      {
        type: "dependency-cycle",
        modules: ["a", "b"],
        files: ["src/a.ts", "src/b.ts"],
      },
    ],
    expectedImpact: { simulated: [], estimated: [], unknowns: [] },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "conditional", factors: ["Restore edge."] },
    preconditions: ["Edge exists."],
    constraints: ["Preserve behavior."],
    rollbackStrategy: "Restore edge.",
    ranking: {
      severity: 3,
      confidence: 3,
      expectedBenefit: 3,
      riskPenalty: 0,
      deterministicTieBreaker: "P-BC-12345678",
    },
    alternatives: [
      {
        strategy: "introduce-boundary",
        selectedEdge: {
          fromModule: "b",
          toModule: "a",
          files: ["src/a.ts", "src/b.ts"],
        },
        affectedFiles: ["src/a.ts", "src/b.ts"],
        affectedModules: ["a", "b"],
        rationale: "Reverse edge is also actionable.",
        evidence: [
          {
            type: "dependency-cycle",
            modules: ["a", "b"],
            files: ["src/a.ts", "src/b.ts"],
          },
        ],
        expectedImpact: { simulated: [], estimated: [], unknowns: [] },
        risk: { level: "low", points: 0, factors: [] },
        reversibility: { level: "conditional", factors: ["Restore edge."] },
      },
    ],
  });

describe("proposal evaluator", () => {
  it("matches exact and one-of-several acceptable targets", () => {
    const proposal = extractionProposal();
    expect(proposalMatchesExpectation(proposal, expected())).toBe(true);
    expect(
      proposalMatchesExpectation(
        proposal,
        expected({
          acceptableFiles: [
            ["src/other.ts"],
            ["src/modules/orders/service.ts"],
          ],
        }),
      ),
    ).toBe(true);
  });

  it("reports unmatched issues, unexpected proposals, and clean false positives", () => {
    const proposal = extractionProposal();
    expect(
      matchProposals(
        [proposal],
        [expected({ acceptableFiles: [["src/not-present.ts"]] })],
      ),
    ).toMatchObject({
      unmatched: [{ id: "notification-cluster" }],
      unexpected: [proposal],
    });
    const clean = evaluate([proposal], {
      schemaVersion: 1,
      version: "v1",
      issues: [],
    });
    expect(clean.proposalValidity).toBe(0);
    expect(clean.unexpectedProposalIds).toEqual([proposal.id]);
  });

  it("checks top-K, required evidence, and evidence values independently", () => {
    const actual = extractionProposal();
    const decoy = extractionProposal("P-EM-87654321", "src/other.ts");
    expect(evaluate([decoy, actual]).topKCoverage).toBe(0);

    const missing = { ...actual, evidence: actual.evidence.slice(0, 1) };
    expect(evaluate([missing]).evidenceCoverage).toBe(0.5);

    const incorrect = {
      ...actual,
      evidence: actual.evidence.map((item) =>
        item.type === "oversized-file" ? { ...item, actualLines: 999 } : item,
      ),
    };
    expect(evaluate([incorrect]).evidenceCorrectness).toBe(0.5);
  });

  it("compares risk and reversibility against allowed human labels", () => {
    expect(evaluate().riskClassificationAgreement).toBe(1);
    expect(
      evaluate(undefined, {
        schemaVersion: 1,
        version: "v1",
        issues: [
          expected({
            expectedRisk: { allowed: ["high"] },
            expectedReversibility: { allowed: ["difficult"] },
          }),
        ],
      }),
    ).toMatchObject({
      riskClassificationAgreement: 0,
      reversibilityClassificationAgreement: 0,
    });
  });

  it("separates reviewed rejected and ambiguous proposals from unknown output", () => {
    const proposal = extractionProposal();
    const reviewed = (classification: "rejected" | "ambiguous") =>
      evaluate([proposal], {
        schemaVersion: 1,
        version: "v1",
        issues: [],
        reviewedProposals: [
          { ...expected(), classification, maximumAffectedFiles: 1 },
        ],
      });
    expect(reviewed("rejected")).toMatchObject({
      proposalValidity: 0,
      rejectedProposalIds: [proposal.id],
      ambiguousProposalIds: [],
      unexpectedProposalIds: [],
    });
    expect(reviewed("ambiguous")).toMatchObject({
      proposalValidity: 1,
      rejectedProposalIds: [],
      ambiguousProposalIds: [proposal.id],
      unexpectedProposalIds: [],
    });
  });

  it("matches multiple accepted issues through one top-level primary and its alternatives", () => {
    const proposal = groupedCycleProposal();
    const cycleIssue = (
      id: string,
      fromModule: string,
      toModule: string,
    ): IssueExpectation => ({
      id,
      type: "break-cycle",
      acceptableModules: [["a", "b"]],
      acceptableCycleEdges: [{ fromModule, toModule }],
      requiredEvidenceTypes: ["dependency-cycle"],
      notes: "Reviewed cycle action.",
    });
    expect(
      evaluate([proposal], {
        schemaVersion: 1,
        version: "1.1.0",
        issues: [
          cycleIssue("a-to-b", "a", "b"),
          cycleIssue("b-to-a", "b", "a"),
        ],
      }),
    ).toMatchObject({
      matchedIssueIds: ["a-to-b", "b-to-a"],
      acceptedProposalIds: [proposal.id],
      proposalValidity: 1,
      unexpectedProposalIds: [],
    });

    const unexpected = extractionProposal();
    expect(
      evaluate([proposal, unexpected], {
        schemaVersion: 1,
        version: "1.1.0",
        issues: [
          cycleIssue("a-to-b", "a", "b"),
          cycleIssue("b-to-a", "b", "a"),
        ],
      }).proposalValidity,
    ).toBeCloseTo(2 / 3);
  });
});
