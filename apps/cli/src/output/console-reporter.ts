import path from "node:path";
import type { ArchitectureSnapshot } from "@braid/core";

const warning = (value: number): string => (value > 0 ? " [warning]" : "");

export const formatConsoleReport = (
  snapshot: ArchitectureSnapshot,
  savedPath: string | null,
): string => {
  const metrics = snapshot.metrics;
  const saved = savedPath
    ? path.relative(snapshot.projectRoot, savedPath).replaceAll("\\", "/")
    : "not saved";

  return [
    "Braid analysis",
    "",
    `Project: ${snapshot.projectRoot}`,
    `Source files: ${metrics.totalSourceFiles}`,
    `Modules: ${metrics.totalModules}`,
    `Internal imports: ${metrics.totalInternalImports}`,
    `External imports: ${metrics.totalExternalImports}`,
    `Cross-module imports: ${metrics.crossModuleImports}`,
    `Circular dependencies: ${metrics.circularDependencies}${warning(metrics.circularDependencies)}`,
    `Oversized files: ${metrics.oversizedFiles}${warning(metrics.oversizedFiles)}`,
    `Oversized modules: ${metrics.oversizedModules}${warning(metrics.oversizedModules)}`,
    `Public entrypoints: ${metrics.publicEntrypointCount}`,
    "",
    `Snapshot: ${snapshot.id}`,
    `Saved: ${saved}`,
  ].join("\n");
};
