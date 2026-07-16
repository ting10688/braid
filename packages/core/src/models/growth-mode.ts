import { z } from "zod";

export const GROWTH_MODE_SCHEMA_VERSION = "1.0.0" as const;
export const GROWTH_MODE_PROTOCOL_VERSION = "1.0.0" as const;

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const portablePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("../") &&
      !/^[A-Za-z]:[\\/]/u.test(value),
    "must be a repository-relative path",
  );

export const growthModeReportStatusSchema = z.enum(["pass", "warn", "block"]);
export const growthModeFindingSeveritySchema = z.enum([
  "info",
  "warn",
  "block",
]);
export const growthModeRuleIdSchema = z.enum([
  "new-cycle",
  "oversized-threshold-crossed",
  "oversized-module-growth",
  "pre-existing-issue-removed",
  "analysis-incomplete",
]);

export const growthModeImportEdgeEvidenceSchema = z.object({
  fromFile: portablePathSchema,
  toFile: portablePathSchema,
  fromModule: z.string().min(1),
  toModule: z.string().min(1),
  typeOnly: z.boolean(),
});

export const growthModeFindingSchema = z.object({
  id: z.string().regex(/^GF-[a-f0-9]{12}$/u),
  ruleId: growthModeRuleIdSchema,
  severity: growthModeFindingSeveritySchema,
  title: z.string().min(1),
  files: z.array(portablePathSchema),
  symbols: z.array(z.string().min(1)),
  edges: z.array(growthModeImportEdgeEvidenceSchema),
  baselineEvidence: z.array(z.string().min(1)),
  currentEvidence: z.array(z.string().min(1)),
  consequence: z.string().min(1),
  suggestions: z.array(z.string().min(1)).min(1).max(2),
});

export const growthModeRepositoryIdentitySchema = z.object({
  repositoryId: fingerprintSchema,
  worktreeId: fingerprintSchema,
});

export const growthModeBaselineIdentitySchema = z.object({
  id: z.string().regex(/^GB-[a-f0-9]{12}$/u),
  gitFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  architectureFingerprint: fingerprintSchema,
  configFingerprint: fingerprintSchema,
});

export const growthModeCurrentIdentitySchema = z.object({
  head: z.string().min(1).nullable(),
  gitFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  architectureFingerprint: fingerprintSchema,
});

export const growthModeAdapterCompatibilitySchema = z.object({
  protocolVersion: z.literal(GROWTH_MODE_PROTOCOL_VERSION),
  adapter: z.string().min(1),
  adapterVersion: z.string().min(1),
  providerVersion: z.string().min(1).nullable(),
  supportedEvents: z.array(z.string().min(1)),
  capabilities: z.object({
    sessionContext: z.boolean(),
    promptContext: z.boolean(),
    postToolContext: z.boolean(),
    stopBlocking: z.boolean(),
    repositoryLocalConfiguration: z.boolean(),
    requiresTrust: z.boolean(),
  }),
});

export const growthModeSkippedReasonSchema = z.enum([
  "growth-mode-disabled",
  "baseline-initialized",
  "no-relevant-change",
]);

export const growthModeReportSchema = z.object({
  schemaVersion: z.literal(GROWTH_MODE_SCHEMA_VERSION),
  id: z.string().regex(/^GR-[a-f0-9]{12}$/u),
  sessionId: z.string().min(1),
  repository: growthModeRepositoryIdentitySchema,
  baseline: growthModeBaselineIdentitySchema,
  current: growthModeCurrentIdentitySchema,
  diffFingerprint: fingerprintSchema,
  changedPaths: z.array(portablePathSchema),
  affectedPaths: z.array(portablePathSchema),
  status: growthModeReportStatusSchema,
  findings: z.array(growthModeFindingSchema),
  skippedReason: growthModeSkippedReasonSchema.nullable(),
  cacheHit: z.boolean(),
  generatedAt: z.string().datetime().optional(),
  compatibility: growthModeAdapterCompatibilitySchema,
  statistics: z.object({
    noChangeSkip: z.boolean(),
    analysisDurationMs: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    affectedFileCount: z.number().int().nonnegative(),
  }),
});

export type GrowthModeReportStatus = z.infer<
  typeof growthModeReportStatusSchema
>;
export type GrowthModeFindingSeverity = z.infer<
  typeof growthModeFindingSeveritySchema
>;
export type GrowthModeRuleId = z.infer<typeof growthModeRuleIdSchema>;
export type GrowthModeFinding = z.infer<typeof growthModeFindingSchema>;
export type GrowthModeRepositoryIdentity = z.infer<
  typeof growthModeRepositoryIdentitySchema
>;
export type GrowthModeBaselineIdentity = z.infer<
  typeof growthModeBaselineIdentitySchema
>;
export type GrowthModeCurrentIdentity = z.infer<
  typeof growthModeCurrentIdentitySchema
>;
export type GrowthModeAdapterCompatibility = z.infer<
  typeof growthModeAdapterCompatibilitySchema
>;
export type GrowthModeSkippedReason = z.infer<
  typeof growthModeSkippedReasonSchema
>;
export type GrowthModeReport = z.infer<typeof growthModeReportSchema>;
