import { z } from "zod";

export const projectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.split("/").some((segment) => ["", ".", ".."].includes(segment)),
    "must be a normalized POSIX project-relative path",
  );

export const proposalTypeSchema = z.enum(["extract-module", "break-cycle"]);
export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export const reversibilityLevelSchema = z.enum([
  "easy",
  "conditional",
  "difficult",
]);

export const cycleStrategySchema = z.enum([
  "introduce-boundary",
  "dependency-inversion",
  "move-shared-contract",
]);

export const selectedCycleEdgeSchema = z.object({
  fromModule: z.string().min(1),
  toModule: z.string().min(1),
  files: z.array(projectRelativePathSchema).min(1),
});

export const proposalTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("extract-module"),
    sourceFile: projectRelativePathSchema,
    sourceModule: z.string().min(1),
    candidateSymbols: z.array(z.string().min(1)).min(2),
    approvedCompanionSymbols: z
      .array(
        z.object({
          file: projectRelativePathSchema,
          symbol: z.string().min(1),
        }),
      )
      .min(1)
      .optional(),
    suggestedModuleName: z.string().min(1),
  }),
  z.object({
    type: z.literal("break-cycle"),
    cycleModules: z.array(z.string().min(1)).min(2),
    cycleFiles: z.array(projectRelativePathSchema).min(1),
    selectedEdge: selectedCycleEdgeSchema,
    suggestedStrategy: cycleStrategySchema,
    rootCauseSignature: z
      .string()
      .regex(/^CR-[a-f0-9]{12}$/u)
      .optional(),
    rootCauseModules: z.array(z.string().min(1)).min(2).optional(),
  }),
]);

export const proposalEvidenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("oversized-file"),
    file: projectRelativePathSchema,
    actualLines: z.number().int().nonnegative(),
    thresholdLines: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("oversized-module"),
    module: z.string().min(1),
    actualFiles: z.number().int().nonnegative(),
    actualExports: z.number().int().nonnegative(),
    fileThreshold: z.number().int().positive(),
    exportThreshold: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("dependency-cycle"),
    modules: z.array(z.string().min(1)).min(2),
    files: z.array(projectRelativePathSchema).min(1),
  }),
  z.object({
    type: z.literal("cycle-edge"),
    fromModule: z.string().min(1),
    toModule: z.string().min(1),
    importingFiles: z.array(projectRelativePathSchema).min(1),
    importCount: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("symbol-cluster"),
    sourceFile: projectRelativePathSchema,
    symbols: z.array(z.string().min(1)).min(2),
    sharedTokens: z.array(z.string().min(1)),
    internalReferenceCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("public-entrypoint-impact"),
    files: z.array(projectRelativePathSchema).min(1),
  }),
  z.object({
    type: z.literal("protected-path-impact"),
    files: z.array(projectRelativePathSchema).min(1),
  }),
  z.object({
    type: z.literal("architecture-constraint"),
    constraint: z.string().min(1),
    details: z.string().min(1),
  }),
]);

export const impactObservationSchema = z.object({
  metric: z.enum([
    "circularDependencies",
    "oversizedFiles",
    "oversizedModules",
    "crossModuleImports",
    "boundaryViolations",
    "publicApiSurface",
  ]),
  direction: z.enum(["decrease", "unchanged", "increase", "unknown"]),
  delta: z.number().int().optional(),
  rationale: z.string().min(1),
});

export const expectedImpactSchema = z.object({
  simulated: z.array(impactObservationSchema),
  estimated: z.array(impactObservationSchema),
  unknowns: z.array(z.string().min(1)),
});

export const riskFactorSchema = z.object({
  type: z.enum([
    "affected-files-over-5",
    "affected-files-over-10",
    "modules-over-2",
    "public-entrypoint",
    "protected-path",
    "long-cycle",
    "low-confidence",
    "new-public-contract",
    "module-surface",
  ]),
  points: z.number().int().positive(),
  details: z.string().min(1),
});

export const riskAssessmentSchema = z
  .object({
    level: riskLevelSchema,
    points: z.number().int().nonnegative(),
    factors: z.array(riskFactorSchema),
  })
  .superRefine((risk, context) => {
    const points = risk.factors.reduce(
      (total, factor) => total + factor.points,
      0,
    );
    const level = points <= 1 ? "low" : points <= 4 ? "medium" : "high";
    if (risk.points !== points)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message: "must equal the sum of factor points",
      });
    if (risk.level !== level)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: `must be ${level} for ${points} points`,
      });
  });

export const reversibilityAssessmentSchema = z.object({
  level: reversibilityLevelSchema,
  factors: z.array(z.string().min(1)),
});

export const proposalRankingSchema = z.object({
  severity: z.number().int().min(0).max(3),
  confidence: z.number().int().min(0).max(3),
  expectedBenefit: z.number().int().min(0).max(3),
  riskPenalty: z.number().int().nonnegative(),
  deterministicTieBreaker: z.string().min(1),
});

export const proposalAlternativeSchema = z.object({
  strategy: cycleStrategySchema,
  selectedEdge: selectedCycleEdgeSchema,
  affectedFiles: z.array(projectRelativePathSchema).min(1),
  affectedModules: z.array(z.string().min(1)).min(2),
  rationale: z.string().min(1),
  evidence: z.array(proposalEvidenceSchema).min(1),
  expectedImpact: expectedImpactSchema,
  risk: riskAssessmentSchema,
  reversibility: reversibilityAssessmentSchema,
});

export const migrationProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^P-(?:EM|BC)-[a-f0-9]{8}$/u),
    snapshotId: z.string().min(1),
    type: proposalTypeSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    affectedFiles: z.array(projectRelativePathSchema),
    affectedModules: z.array(z.string().min(1)),
    target: proposalTargetSchema,
    evidence: z.array(proposalEvidenceSchema).min(1),
    expectedImpact: expectedImpactSchema,
    risk: riskAssessmentSchema,
    reversibility: reversibilityAssessmentSchema,
    preconditions: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    rollbackStrategy: z.string().min(1),
    ranking: proposalRankingSchema,
    alternatives: z.array(proposalAlternativeSchema).optional(),
  })
  .refine((proposal) => proposal.type === proposal.target.type, {
    path: ["target", "type"],
    message: "must match proposal type",
  })
  .refine(
    (proposal) => proposal.type === "break-cycle" || !proposal.alternatives,
    {
      path: ["alternatives"],
      message: "only break-cycle proposals may contain alternatives",
    },
  )
  .superRefine((proposal, context) => {
    if (proposal.target.type !== "extract-module") return;
    const approved = proposal.target.approvedCompanionSymbols ?? [];
    const keys = approved.map(({ file, symbol }) => `${file}\0${symbol}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["target", "approvedCompanionSymbols"],
        message: "must not contain duplicate companion symbols",
      });
    const primary = new Set(proposal.target.candidateSymbols);
    const sourceFile = proposal.target.sourceFile;
    approved.forEach(({ file, symbol }, index) => {
      if (file === sourceFile && primary.has(symbol))
        context.addIssue({
          code: "custom",
          path: ["target", "approvedCompanionSymbols", index],
          message: "companion symbol must be distinct from primary symbols",
        });
    });
  });

export type ProposalType = z.infer<typeof proposalTypeSchema>;
export type ProposalTarget = z.infer<typeof proposalTargetSchema>;
export type ProposalEvidence = z.infer<typeof proposalEvidenceSchema>;
export type ImpactObservation = z.infer<typeof impactObservationSchema>;
export type ExpectedImpact = z.infer<typeof expectedImpactSchema>;
export type RiskFactor = z.infer<typeof riskFactorSchema>;
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;
export type ReversibilityAssessment = z.infer<
  typeof reversibilityAssessmentSchema
>;
export type ProposalRanking = z.infer<typeof proposalRankingSchema>;
export type ProposalAlternative = z.infer<typeof proposalAlternativeSchema>;
export type MigrationProposal = z.infer<typeof migrationProposalSchema>;
