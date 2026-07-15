import path from "node:path";
import { access, glob } from "node:fs/promises";
import { DiagnosticCategory, Project, ts, type SourceFile } from "ts-morph";
import type { ArchitectureConfig, SourceFileRecord } from "@braid/core";
import { AnalysisError, projectRelativePath } from "@braid/shared";

export interface ScannedImport {
  fromFile: string;
  specifier: string;
  resolvedFile: string | null;
}

export interface ScanResult {
  files: SourceFileRecord[];
  imports: ScannedImport[];
  warnings: string[];
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const countLinesOfCode = (contents: string): number =>
  contents.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== "" &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      trimmed !== "*/"
    );
  }).length;

const isTestFile = (filePath: string): boolean =>
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(
    filePath,
  );

const sourceModuleSpecifiers = (sourceFile: SourceFile): string[] => [
  ...sourceFile
    .getImportDeclarations()
    .map((declaration) => declaration.getModuleSpecifierValue()),
  ...sourceFile
    .getExportDeclarations()
    .map((declaration) => declaration.getModuleSpecifierValue())
    .filter((value): value is string => value !== undefined),
];

const resolveImport = (
  specifier: string,
  sourcePath: string,
  project: Project,
  selectedFiles: Map<string, string>,
): string | null => {
  const resolved = ts.resolveModuleName(
    specifier,
    sourcePath,
    project.getCompilerOptions(),
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (resolved) {
    const selected = selectedFiles.get(path.resolve(resolved));
    if (selected) return selected;
  }

  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = [
    base,
    base.replace(/\.[cm]?js$/u, ".ts"),
    base.replace(/\.[cm]?js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    const selected = selectedFiles.get(path.resolve(candidate));
    if (selected) return selected;
  }
  return null;
};

export const scanRepository = async (
  projectRoot: string,
  config: ArchitectureConfig,
): Promise<ScanResult> => {
  const root = path.resolve(projectRoot);
  const warnings: string[] = [];
  const matched = new Set<string>();

  try {
    for await (const filePath of glob(config.source.include, {
      cwd: root,
      exclude: config.source.exclude,
    })) {
      matched.add(path.resolve(root, filePath));
    }
  } catch (error) {
    throw new AnalysisError("Failed to evaluate configured source patterns", {
      cause: error,
    });
  }

  const absolutePaths = [...matched].sort((left, right) =>
    left.localeCompare(right),
  );
  const selectedFiles = new Map(
    absolutePaths.map((absolutePath) => [
      absolutePath,
      projectRelativePath(root, absolutePath),
    ]),
  );
  const tsconfigPath = path.join(root, "tsconfig.json");
  const project = (await exists(tsconfigPath))
    ? new Project({
        tsConfigFilePath: tsconfigPath,
        skipAddingFilesFromTsConfig: true,
      })
    : new Project({
        compilerOptions: { moduleResolution: ts.ModuleResolutionKind.NodeNext },
      });

  const sourceFiles: SourceFile[] = [];
  for (const absolutePath of absolutePaths) {
    try {
      sourceFiles.push(project.addSourceFileAtPath(absolutePath));
    } catch (error) {
      warnings.push(
        `${selectedFiles.get(absolutePath)} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const files: SourceFileRecord[] = [];
  const imports: ScannedImport[] = [];
  for (const sourceFile of sourceFiles) {
    const absolutePath = path.resolve(sourceFile.getFilePath());
    const relativePath = selectedFiles.get(absolutePath);
    if (!relativePath) continue;

    const syntaxErrors = sourceFile
      .getPreEmitDiagnostics()
      .filter(
        (diagnostic) => diagnostic.getCategory() === DiagnosticCategory.Error,
      )
      .filter((diagnostic) => diagnostic.getCode() < 2000);
    if (syntaxErrors.length > 0)
      warnings.push(`${relativePath} contains TypeScript syntax errors`);

    const fileImports = [...new Set(sourceModuleSpecifiers(sourceFile))]
      .map((specifier) => ({
        fromFile: relativePath,
        specifier,
        resolvedFile: resolveImport(
          specifier,
          absolutePath,
          project,
          selectedFiles,
        ),
      }))
      .sort((left, right) => left.specifier.localeCompare(right.specifier));
    imports.push(...fileImports);
    files.push({
      path: relativePath,
      linesOfCode: countLinesOfCode(sourceFile.getFullText()),
      exportedSymbols: [...sourceFile.getExportedDeclarations().keys()].sort(),
      importedFiles: fileImports
        .map((item) => item.resolvedFile ?? item.specifier)
        .sort(),
      isTestFile: isTestFile(relativePath),
    });
  }

  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    imports: imports.sort((left, right) =>
      `${left.fromFile}\0${left.specifier}`.localeCompare(
        `${right.fromFile}\0${right.specifier}`,
      ),
    ),
    warnings: warnings.sort(),
  };
};
