import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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
});
