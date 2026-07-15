import { migrationProposalSchema, type MigrationProposal } from "@braid/core";
import { describe, expect, it } from "vitest";
import {
  detectProposalFlakiness,
  normalizeAllowedVolatility,
  type CorrectnessObservation,
} from "../src/evaluators/flakiness-evaluator.js";
import type { BenchmarkProtocol } from "../src/models/benchmark.js";
import { extractionProposal } from "./proposal-fixture.js";

const rules: BenchmarkProtocol["normalizationRules"] = [
  "run-ids",
  "timestamps",
  "temporary-directory-paths",
  "timing-samples",
  "generated-state-paths",
];

const observation = (
  proposals: readonly MigrationProposal[],
  exitCode = 0,
): CorrectnessObservation => ({ proposals, exitCode, sourceMutations: [] });

const changed = (
  proposal: MigrationProposal,
  values: Record<string, unknown>,
): MigrationProposal =>
  migrationProposalSchema.parse({ ...proposal, ...values });

const fields = (
  left: CorrectnessObservation,
  right: CorrectnessObservation,
): string[] =>
  detectProposalFlakiness([left, right], rules).differences.map(
    ({ field }) => field,
  );

describe("correctness normalization and flakiness", () => {
  it("normalizes only configured volatile metadata", () => {
    expect(
      normalizeAllowedVolatility(
        {
          runId: "one",
          createdAt: "2026-07-15T00:00:00.000Z",
          durationMs: 12,
          path: "/tmp/run/.braid/state/snapshots/one.json",
          proposalId: "P-EM-12345678",
          ranking: { severity: 2 },
        },
        rules,
        { temporaryDirectories: ["/tmp/run"] },
      ),
    ).toEqual({
      path: "<temporary-directory>/.braid/state/<generated>",
      proposalId: "P-EM-12345678",
      ranking: { severity: 2 },
    });
  });

  it("keeps timestamp-only snapshot differences stable", () => {
    const first = extractionProposal();
    const second = changed(first, {
      snapshotId: "S-123456789abc-20260716T010203004Z",
    });
    expect(
      detectProposalFlakiness(
        [observation([first]), observation([second])],
        rules,
      ),
    ).toEqual({ flaky: false, differences: [] });
  });

  it("detects proposal order and ID changes", () => {
    const first = extractionProposal();
    const second = extractionProposal("P-EM-87654321", "src/other.ts");
    expect(
      fields(observation([first, second]), observation([second, first])),
    ).toContain("proposalOrder");
    expect(
      fields(
        observation([first]),
        observation([extractionProposal("P-EM-11111111")]),
      ),
    ).toContain("proposalIds");
  });

  it("detects evidence, risk, ranking, and meaningful target changes", () => {
    const proposal = extractionProposal();
    const evidence = changed(proposal, {
      evidence: proposal.evidence.slice(0, 1),
    });
    const risk = changed(proposal, {
      risk: {
        level: "high",
        points: 5,
        factors: [
          {
            type: "affected-files-over-5",
            points: 5,
            details: "changed",
          },
        ],
      },
    });
    const ranking = changed(proposal, {
      ranking: { ...proposal.ranking, severity: 3 },
    });
    const target = extractionProposal(undefined, "src/changed.ts");
    expect(fields(observation([proposal]), observation([evidence]))).toContain(
      "evidence",
    );
    expect(fields(observation([proposal]), observation([risk]))).toContain(
      "risk",
    );
    expect(fields(observation([proposal]), observation([ranking]))).toContain(
      "ranking",
    );
    expect(fields(observation([proposal]), observation([target]))).toContain(
      "proposalTargets",
    );
  });

  it("detects exit-code changes and reports repetitions", () => {
    const proposal = extractionProposal();
    const result = detectProposalFlakiness(
      [observation([proposal]), observation([proposal], 1)],
      rules,
    );
    expect(result.flaky).toBe(true);
    expect(result.differences).toContainEqual({
      field: "exitCode",
      repetitions: [1, 2],
    });
  });
});
