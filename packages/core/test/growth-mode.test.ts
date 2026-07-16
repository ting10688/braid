import { describe, expect, it } from "vitest";
import {
  GROWTH_MODE_PROTOCOL_VERSION,
  GROWTH_MODE_SCHEMA_VERSION,
  growthModeReportSchema,
  growthModeReportStatusSchema,
} from "../src/index.js";

const hash = "a".repeat(64);

const report = {
  schemaVersion: GROWTH_MODE_SCHEMA_VERSION,
  id: `GR-${"b".repeat(12)}`,
  sessionId: "session-1",
  repository: { repositoryId: hash, worktreeId: hash },
  baseline: {
    id: `GB-${"c".repeat(12)}`,
    gitFingerprint: hash,
    sourceFingerprint: hash,
    architectureFingerprint: hash,
    configFingerprint: hash,
  },
  current: {
    head: null,
    gitFingerprint: hash,
    sourceFingerprint: hash,
    architectureFingerprint: hash,
  },
  diffFingerprint: hash,
  changedPaths: ["src/orders.ts"],
  affectedPaths: ["src/orders.ts"],
  status: "warn",
  findings: [
    {
      id: `GF-${"d".repeat(12)}`,
      ruleId: "oversized-threshold-crossed",
      severity: "warn",
      title: "Orders crossed the module size threshold",
      files: ["src/orders.ts"],
      symbols: [],
      edges: [],
      baselineEvidence: ["19 files"],
      currentEvidence: ["21 files"],
      consequence: "The module now exceeds the configured threshold.",
      suggestions: ["Keep the next change in a smaller module."],
    },
  ],
  skippedReason: null,
  cacheHit: false,
  generatedAt: "2026-07-16T00:00:00.000Z",
  compatibility: {
    protocolVersion: GROWTH_MODE_PROTOCOL_VERSION,
    adapter: "braid-cli",
    adapterVersion: "0.1.0",
    providerVersion: null,
    supportedEvents: [],
    capabilities: {
      sessionContext: false,
      promptContext: false,
      postToolContext: false,
      stopBlocking: false,
      repositoryLocalConfiguration: false,
      requiresTrust: false,
    },
  },
  statistics: {
    noChangeSkip: false,
    analysisDurationMs: 1,
    changedFileCount: 1,
    affectedFileCount: 1,
  },
} as const;

describe("Growth Mode public models", () => {
  it("exposes exactly pass, warn, and block report statuses", () => {
    expect(growthModeReportStatusSchema.options).toEqual([
      "pass",
      "warn",
      "block",
    ]);
  });

  it("accepts a portable versioned report", () => {
    expect(growthModeReportSchema.parse(report)).toEqual(report);
  });

  it("rejects private absolute paths in reports", () => {
    expect(() =>
      growthModeReportSchema.parse({
        ...report,
        changedPaths: ["/Users/example/private.ts"],
      }),
    ).toThrow(/repository-relative/u);
  });
});
