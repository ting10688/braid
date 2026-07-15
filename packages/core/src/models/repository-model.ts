import { z } from "zod";

export const sourceFileRecordSchema = z.object({
  path: z.string().min(1),
  linesOfCode: z.number().int().nonnegative(),
  exportedSymbols: z.array(z.string()),
  importedFiles: z.array(z.string()),
  isTestFile: z.boolean(),
});

export const moduleRecordSchema = z.object({
  id: z.string().min(1),
  paths: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
  exportedSymbolCount: z.number().int().nonnegative(),
  incomingDependencies: z.array(z.string()),
  outgoingDependencies: z.array(z.string()),
});

export const importEdgeSchema = z.object({
  fromFile: z.string().min(1),
  toFile: z.string().min(1),
  fromModule: z.string().min(1),
  toModule: z.string().min(1),
  kind: z.enum(["internal", "external"]),
});

export const dependencyCycleSchema = z.object({
  modules: z.array(z.string()).min(1),
  files: z.array(z.string()).min(1),
});

export const repositoryModelSchema = z.object({
  projectRoot: z.string().min(1),
  language: z.literal("typescript"),
  files: z.array(sourceFileRecordSchema),
  modules: z.array(moduleRecordSchema),
  imports: z.array(importEdgeSchema),
  cycles: z.array(dependencyCycleSchema),
  publicEntrypoints: z.array(z.string()),
});

export type SourceFileRecord = z.infer<typeof sourceFileRecordSchema>;
export type ModuleRecord = z.infer<typeof moduleRecordSchema>;
export type ImportEdge = z.infer<typeof importEdgeSchema>;
export type DependencyCycle = z.infer<typeof dependencyCycleSchema>;
export type RepositoryModel = z.infer<typeof repositoryModelSchema>;
