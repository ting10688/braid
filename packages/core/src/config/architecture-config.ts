import { z } from "zod";

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
});

export type ArchitectureConfig = z.infer<typeof architectureConfigSchema>;

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
`;
