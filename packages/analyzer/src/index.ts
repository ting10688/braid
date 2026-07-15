import path from "node:path";
import {
  repositoryModelSchema,
  type ArchitectureConfig,
  type ModuleRecord,
  type RepositoryModel,
} from "@braid/core";
import { buildImportGraph } from "./import-graph.js";
import { findDependencyCycles } from "./cycle-detector.js";
import {
  classifyModule,
  classifySourceFiles,
  findPublicEntrypoints,
  type ModuleClassification,
} from "./module-classifier.js";
import { calculateMetrics } from "./metrics-calculator.js";
import { scanRepository } from "./repo-scanner.js";

const buildModules = (
  files: RepositoryModel["files"],
  imports: RepositoryModel["imports"],
  classifications: ReadonlyMap<string, ModuleClassification>,
): ModuleRecord[] => {
  const ids = [
    ...new Set(
      files.map(
        (file) =>
          classifications.get(file.path)?.id ?? classifyModule(file.path),
      ),
    ),
  ].sort();
  return ids.map((id) => {
    const moduleFiles = files.filter(
      (file) =>
        (classifications.get(file.path)?.id ?? classifyModule(file.path)) ===
        id,
    );
    const incoming = imports
      .filter(
        (edge) =>
          edge.kind === "internal" &&
          edge.toModule === id &&
          edge.fromModule !== id,
      )
      .map((edge) => edge.fromModule);
    const outgoing = imports
      .filter(
        (edge) =>
          edge.kind === "internal" &&
          edge.fromModule === id &&
          edge.toModule !== id,
      )
      .map((edge) => edge.toModule);
    return {
      id,
      kind: classifications.get(moduleFiles[0]!.path)?.kind ?? "feature",
      paths: moduleFiles.map((file) => file.path).sort(),
      fileCount: moduleFiles.length,
      exportedSymbolCount: moduleFiles.reduce(
        (total, file) => total + file.exportedSymbols.length,
        0,
      ),
      incomingDependencies: [...new Set(incoming)].sort(),
      outgoingDependencies: [...new Set(outgoing)].sort(),
    };
  });
};

export interface AnalysisResult {
  repository: RepositoryModel;
  metrics: ReturnType<typeof calculateMetrics>;
  warnings: string[];
}

export const analyzeRepository = async (
  projectRoot: string,
  config: ArchitectureConfig,
): Promise<AnalysisResult> => {
  const root = path.resolve(projectRoot);
  const scan = await scanRepository(root, config);
  const publicEntrypoints = await findPublicEntrypoints(root, scan.files);
  const classifications = classifySourceFiles(scan.files, publicEntrypoints);
  const moduleFor = (filePath: string): string =>
    classifications.get(filePath)?.id ?? classifyModule(filePath);
  const imports = buildImportGraph(scan.files, scan.imports, moduleFor);
  const repository = repositoryModelSchema.parse({
    projectRoot: root,
    language: "typescript",
    files: scan.files,
    modules: buildModules(scan.files, imports, classifications),
    imports,
    cycles: findDependencyCycles(imports),
    publicEntrypoints,
  });

  return {
    repository,
    metrics: calculateMetrics(repository, config.thresholds),
    warnings: scan.warnings,
  };
};

export * from "./cycle-detector.js";
export * from "./import-graph.js";
export * from "./metrics-calculator.js";
export * from "./module-classifier.js";
export * from "./repo-scanner.js";
