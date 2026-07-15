import { describe, expect, it } from "vitest";
import {
  expectedIssueIsWithinTopK,
  observedOrderIsDeterministic,
  observedProposalOrder,
} from "../src/evaluators/ranking-evaluator.js";
import type { IssueExpectation } from "../src/models/benchmark.js";
import { extractionProposal } from "./proposal-fixture.js";

const expected: IssueExpectation = {
  id: "notification",
  type: "extract-module",
  acceptableFiles: [["src/modules/orders/service.ts"]],
  requiredEvidenceTypes: [],
  notes: "Expected notification extraction.",
};

describe("observed ranking evaluator", () => {
  it("finds a required issue within top K", () => {
    expect(expectedIssueIsWithinTopK([extractionProposal()], expected, 1)).toBe(
      true,
    );
  });

  it("detects input-order changes without rerunning Braid ranking", () => {
    const first = extractionProposal("P-EM-12345678");
    const second = extractionProposal("P-EM-87654321", "src/other.ts");
    expect(
      observedOrderIsDeterministic([
        [first, second],
        [second, first],
      ]),
    ).toBe(false);
    expect(
      observedOrderIsDeterministic([
        [first, second],
        [first, second],
      ]),
    ).toBe(true);
  });

  it("preserves stable tie order exactly as emitted", () => {
    const proposals = [
      extractionProposal("P-EM-12345678"),
      extractionProposal("P-EM-87654321", "src/other.ts"),
    ];
    expect(observedProposalOrder(proposals)).toEqual([
      "P-EM-12345678",
      "P-EM-87654321",
    ]);
  });
});
