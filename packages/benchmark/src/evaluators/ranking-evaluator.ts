import type { MigrationProposal } from "@braid/core";
import type { IssueExpectation } from "../models/benchmark.js";
import { proposalMatchesExpectation } from "./proposal-evaluator.js";

export const observedProposalOrder = (
  proposals: readonly MigrationProposal[],
): string[] => proposals.map(({ id }) => id);

export const observedOrderIsDeterministic = (
  runs: readonly (readonly MigrationProposal[])[],
): boolean => {
  const orders = runs.map((run) => observedProposalOrder(run).join("\0"));
  return orders.every((order) => order === orders[0]);
};

export const expectedIssueIsWithinTopK = (
  proposals: readonly MigrationProposal[],
  expectation: IssueExpectation,
  topK: number,
): boolean =>
  proposals
    .slice(0, topK)
    .some((proposal) => proposalMatchesExpectation(proposal, expectation));
