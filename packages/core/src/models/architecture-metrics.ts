import { z } from "zod";

export const architectureMetricsSchema = z.object({
  totalSourceFiles: z.number().int().nonnegative(),
  totalModules: z.number().int().nonnegative(),
  totalInternalImports: z.number().int().nonnegative(),
  totalExternalImports: z.number().int().nonnegative(),
  crossModuleImports: z.number().int().nonnegative(),
  circularDependencies: z.number().int().nonnegative(),
  oversizedFiles: z.number().int().nonnegative(),
  oversizedModules: z.number().int().nonnegative(),
  publicEntrypointCount: z.number().int().nonnegative(),
});

export type ArchitectureMetrics = z.infer<typeof architectureMetricsSchema>;
