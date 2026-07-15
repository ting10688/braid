import { z } from "zod";

export const topLevelDeclarationRecordSchema = z.object({
  name: z.string().min(1),
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type-alias",
    "enum",
    "variable",
  ]),
  exported: z.boolean(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  references: z.array(z.string().min(1)),
});

export const sourceFileRecordSchema = z.object({
  path: z.string().min(1),
  linesOfCode: z.number().int().nonnegative(),
  exportedSymbols: z.array(z.string()),
  importedFiles: z.array(z.string()),
  isTestFile: z.boolean(),
  declarations: z.array(topLevelDeclarationRecordSchema).optional(),
  topLevelStatements: z
    .object({
      imports: z.number().int().nonnegative(),
      reExports: z.number().int().nonnegative(),
      implementation: z.number().int().nonnegative(),
    })
    .optional(),
});

export const moduleKindSchema = z.enum([
  "feature",
  "entrypoint",
  "barrel",
  "root-file",
  "infrastructure",
]);

export const moduleRecordSchema = z.object({
  id: z.string().min(1),
  kind: moduleKindSchema.default("feature"),
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
  typeOnly: z.boolean().default(false),
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
export type TopLevelDeclarationRecord = z.infer<
  typeof topLevelDeclarationRecordSchema
>;
export type ModuleRecord = z.infer<typeof moduleRecordSchema>;
export type ModuleKind = z.infer<typeof moduleKindSchema>;
export type ImportEdge = z.infer<typeof importEdgeSchema>;
export type DependencyCycle = z.infer<typeof dependencyCycleSchema>;
export type RepositoryModel = z.infer<typeof repositoryModelSchema>;
