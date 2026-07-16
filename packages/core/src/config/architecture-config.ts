import { z } from "zod";
import { validationCommandSchema } from "../models/migration-execution.js";

const unique = <T>(values: T[]): boolean =>
  new Set(values).size === values.length;

export const growthModeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  enforcement: z.enum(["warn", "block"]).default("block"),
  blockOn: z
    .array(z.literal("new-cycle"))
    .refine(unique, { message: "must not contain duplicate rules" })
    .default(["new-cycle"]),
  warnOn: z
    .array(z.enum(["oversized-threshold-crossed", "oversized-module-growth"]))
    .refine(unique, { message: "must not contain duplicate rules" })
    .default(["oversized-threshold-crossed", "oversized-module-growth"]),
  maxFindings: z.number().int().min(1).max(50).default(5),
  maxFeedbackCharacters: z.number().int().min(256).max(50_000).default(4_000),
  stopBlocksPerFingerprint: z.number().int().min(0).max(5).default(1),
});

const migrationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  supportedProposalTypes: z
    .array(z.literal("extract-module"))
    .length(1)
    .default(["extract-module"]),
  maximumChangedFiles: z.number().int().min(1).max(8).default(8),
  maximumSymbols: z.number().int().min(2).max(100).default(20),
  codex: z
    .object({
      executable: z
        .string()
        .regex(/^[A-Za-z0-9._+-]+$/u)
        .default("codex"),
      timeoutMs: z.number().int().min(1_000).max(900_000).default(900_000),
      model: z.string().min(1).nullable().default(null),
      reasoningEffort: z.string().min(1).nullable().default(null),
      sandbox: z.literal("workspace-write").default("workspace-write"),
    })
    .default({}),
  validation: z
    .object({
      commands: z.array(validationCommandSchema).default([]),
    })
    .default({}),
});

export const plannerConfigSchema = z.object({
  enabled_proposals: z
    .array(z.enum(["extract-module", "break-cycle"]))
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length, {
      message: "must not contain duplicate proposal types",
    })
    .default(["extract-module", "break-cycle"]),
  max_proposals: z.number().int().min(1).max(100).default(10),
  min_symbol_cluster_size: z.number().int().min(2).max(20).default(2),
  preferred_max_affected_files: z.number().int().min(1).max(1000).default(10),
  include_high_risk: z.boolean().default(true),
});

export const architectureConfigSchema = z.object({
  project: z.object({
    language: z.literal("typescript"),
    architecture_style: z.string().min(1),
  }),
  source: z.object({
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)),
  }),
  constraints: z.object({
    circular_dependencies: z.enum(["forbidden", "allowed"]),
    public_api_changes: z.enum(["approval_required", "allowed"]),
    allow_new_dependencies: z.boolean(),
    preserve_existing_import_paths: z.boolean(),
  }),
  thresholds: z.object({
    oversized_file_lines: z.number().int().positive(),
    oversized_module_files: z.number().int().positive(),
    oversized_module_exports: z.number().int().positive(),
    max_module_dependencies: z.number().int().positive(),
  }),
  protected_paths: z.array(z.string()),
  modules: z.record(z.unknown()),
  planner: plannerConfigSchema.default({
    enabled_proposals: ["extract-module", "break-cycle"],
    max_proposals: 10,
    min_symbol_cluster_size: 2,
    preferred_max_affected_files: 10,
    include_high_risk: true,
  }),
  migration: migrationConfigSchema.default({}),
  growthMode: growthModeConfigSchema.default({ enabled: false }),
});

export type ArchitectureConfig = z.infer<typeof architectureConfigSchema>;
export type GrowthModeConfig = z.infer<typeof growthModeConfigSchema>;

export const DEFAULT_ARCHITECTURE_CONFIG = `project:
  language: typescript
  architecture_style: modular-monolith

source:
  include:
    - src/**/*.ts
    - src/**/*.tsx
  exclude:
    - "**/*.d.ts"
    - "**/node_modules/**"
    - "**/dist/**"
    - "**/build/**"

constraints:
  circular_dependencies: forbidden
  public_api_changes: approval_required
  allow_new_dependencies: false
  preserve_existing_import_paths: true

thresholds:
  oversized_file_lines: 500
  oversized_module_files: 20
  oversized_module_exports: 25
  max_module_dependencies: 8

protected_paths: []
modules: {}

planner:
  enabled_proposals:
    - extract-module
    - break-cycle
  max_proposals: 10
  min_symbol_cluster_size: 2
  preferred_max_affected_files: 10
  include_high_risk: true

migration:
  enabled: false
  supportedProposalTypes:
    - extract-module
  maximumChangedFiles: 8
  maximumSymbols: 20
  codex:
    executable: codex
    timeoutMs: 900000
    model: null
    reasoningEffort: null
    sandbox: workspace-write
  validation:
    commands: []

growthMode:
  enabled: false
  enforcement: block
  blockOn:
    - new-cycle
  warnOn:
    - oversized-threshold-crossed
    - oversized-module-growth
  maxFindings: 5
  maxFeedbackCharacters: 4000
  stopBlocksPerFingerprint: 1
`;
