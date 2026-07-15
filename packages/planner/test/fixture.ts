import {
  classifyModule,
  classifyModuleIdentity,
  findDependencyCycles,
} from "@braid/analyzer";
import {
  configHash,
  migrationConfigHash,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_CONFIG,
  parseArchitectureConfig,
  repositoryModelSchema,
  type ArchitectureSnapshot,
  type ImportEdge,
  type SourceFileRecord,
} from "@braid/core";

export const plannerConfig = parseArchitectureConfig(
  DEFAULT_ARCHITECTURE_CONFIG,
);

interface SnapshotFixture {
  files?: SourceFileRecord[];
  imports?: ImportEdge[];
  publicEntrypoints?: string[];
  createdAt?: Date;
}

export const createPlannerSnapshot = ({
  files,
  imports = [],
  publicEntrypoints = [],
  createdAt = new Date("2026-07-15T00:00:00.000Z"),
}: SnapshotFixture): ArchitectureSnapshot => {
  const sourceFiles =
    files ??
    [...new Set(imports.flatMap((edge) => [edge.fromFile, edge.toFile]))]
      .sort()
      .map((file) => ({
        path: file,
        linesOfCode: 10,
        exportedSymbols: [],
        importedFiles: imports
          .filter((edge) => edge.fromFile === file)
          .map((edge) => edge.toFile)
          .sort(),
        isTestFile: false,
      }));
  const moduleFor = (filePath: string) =>
    classifyModule(filePath, { publicEntrypoints });
  const moduleIds = [
    ...new Set(sourceFiles.map((file) => moduleFor(file.path))),
  ].sort();
  const modules = moduleIds.map((id) => {
    const moduleFiles = sourceFiles.filter(
      (file) => moduleFor(file.path) === id,
    );
    return {
      id,
      kind: classifyModuleIdentity(moduleFiles[0]!.path, {
        publicEntrypoints,
      }).kind,
      paths: moduleFiles.map((file) => file.path).sort(),
      fileCount: moduleFiles.length,
      exportedSymbolCount: moduleFiles.reduce(
        (total, file) => total + file.exportedSymbols.length,
        0,
      ),
      incomingDependencies: [
        ...new Set(
          imports
            .filter((edge) => edge.toModule === id && edge.fromModule !== id)
            .map((edge) => edge.fromModule),
        ),
      ].sort(),
      outgoingDependencies: [
        ...new Set(
          imports
            .filter((edge) => edge.fromModule === id && edge.toModule !== id)
            .map((edge) => edge.toModule),
        ),
      ].sort(),
    };
  });
  const cycles = findDependencyCycles(imports);
  const repository = repositoryModelSchema.parse({
    projectRoot: "/project",
    language: "typescript",
    files: sourceFiles,
    modules,
    imports,
    cycles,
    publicEntrypoints,
  });
  return createArchitectureSnapshot({
    projectRoot: "/project",
    gitCommit: null,
    configHash: configHash(plannerConfig),
    migrationConfigHash: migrationConfigHash(plannerConfig),
    repository,
    metrics: {
      totalSourceFiles: sourceFiles.length,
      totalModules: modules.length,
      totalInternalImports: imports.filter((edge) => edge.kind === "internal")
        .length,
      totalExternalImports: imports.filter((edge) => edge.kind === "external")
        .length,
      crossModuleImports: imports.filter(
        (edge) => edge.kind === "internal" && edge.fromModule !== edge.toModule,
      ).length,
      circularDependencies: cycles.length,
      oversizedFiles: sourceFiles.filter(
        (file) =>
          file.linesOfCode > plannerConfig.thresholds.oversized_file_lines,
      ).length,
      oversizedModules: 0,
      publicEntrypointCount: publicEntrypoints.length,
    },
    createdAt,
  });
};

export const internalEdge = (
  fromModule: string,
  toModule: string,
  fromFile = `src/${fromModule}/${fromModule}.ts`,
  toFile = `src/${toModule}/${toModule}.ts`,
): ImportEdge => ({
  fromFile,
  toFile,
  fromModule,
  toModule,
  kind: "internal",
});
