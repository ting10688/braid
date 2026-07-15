import type {
  ArchitectureConfig,
  ArchitectureMetrics,
  RepositoryModel,
} from "@braid/core";

export const calculateMetrics = (
  repository: RepositoryModel,
  thresholds: ArchitectureConfig["thresholds"],
): ArchitectureMetrics => ({
  totalSourceFiles: repository.files.length,
  totalModules: repository.modules.length,
  totalInternalImports: repository.imports.filter(
    (edge) => edge.kind === "internal",
  ).length,
  totalExternalImports: repository.imports.filter(
    (edge) => edge.kind === "external",
  ).length,
  crossModuleImports: repository.imports.filter(
    (edge) => edge.kind === "internal" && edge.fromModule !== edge.toModule,
  ).length,
  circularDependencies: repository.cycles.length,
  oversizedFiles: repository.files.filter(
    (file) => file.linesOfCode > thresholds.oversized_file_lines,
  ).length,
  oversizedModules: repository.modules.filter(
    (module) =>
      !["entrypoint", "barrel"].includes(module.kind) &&
      (module.fileCount > thresholds.oversized_module_files ||
        module.exportedSymbolCount > thresholds.oversized_module_exports),
  ).length,
  publicEntrypointCount: repository.publicEntrypoints.length,
});
