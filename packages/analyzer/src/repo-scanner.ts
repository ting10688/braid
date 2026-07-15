import path from "node:path";
import { access, glob } from "node:fs/promises";
import {
  DiagnosticCategory,
  Project,
  SyntaxKind,
  ts,
  type Node,
  type SourceFile,
  type Symbol as MorphSymbol,
} from "ts-morph";
import type {
  ArchitectureConfig,
  SourceFileRecord,
  SymbolReferenceRecord,
  TopLevelDeclarationRecord,
} from "@braid/core";
import { AnalysisError, projectRelativePath } from "@braid/shared";

export interface ScannedImport {
  fromFile: string;
  specifier: string;
  resolvedFile: string | null;
  typeOnly: boolean;
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

const sourceModuleSpecifiers = (
  sourceFile: SourceFile,
): Array<{ specifier: string; typeOnly: boolean }> => {
  const imports = sourceFile.getImportDeclarations().map((declaration) => {
    const named = declaration.getNamedImports();
    return {
      specifier: declaration.getModuleSpecifierValue(),
      typeOnly:
        declaration.isTypeOnly() ||
        (declaration.getDefaultImport() === undefined &&
          declaration.getNamespaceImport() === undefined &&
          named.length > 0 &&
          named.every((specifier) => specifier.isTypeOnly())),
    };
  });
  const exports = sourceFile.getExportDeclarations().flatMap((declaration) => {
    const specifier = declaration.getModuleSpecifierValue();
    return specifier ? [{ specifier, typeOnly: declaration.isTypeOnly() }] : [];
  });
  const combined = new Map<string, boolean>();
  for (const item of [...imports, ...exports])
    combined.set(
      item.specifier,
      (combined.get(item.specifier) ?? true) && item.typeOnly,
    );
  return [...combined].map(([specifier, typeOnly]) => ({
    specifier,
    typeOnly,
  }));
};

interface NamedDeclaration {
  name: string;
  kind: TopLevelDeclarationRecord["kind"];
  node: Node;
  referenceNodes: Node[];
}

const terminalAliasedSymbol = (
  symbol: MorphSymbol | undefined,
): MorphSymbol | undefined => {
  const visited = new Set<ts.Symbol>();
  let current = symbol;
  while (current?.isAlias()) {
    if (visited.has(current.compilerSymbol)) return current;
    visited.add(current.compilerSymbol);
    current = current.getAliasedSymbol();
  }
  return current;
};

const declarationName = (node: Node): string | undefined => {
  const named = node as Node & { getName?: () => string | undefined };
  return named.getName?.();
};

const matchesModulePattern = (specifier: string, pattern: string): boolean => {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "u").test(specifier);
};

const topLevelDeclarations = (
  sourceFile: SourceFile,
  relativePath: string,
  imports: ScannedImport[],
  selectedFiles: ReadonlyMap<string, string>,
  localModulePatterns: readonly string[],
): TopLevelDeclarationRecord[] => {
  const declarations: NamedDeclaration[] = [
    ...sourceFile.getFunctions().flatMap((node) => {
      const name = node.getName();
      return name
        ? [
            {
              name,
              kind: "function" as const,
              node,
              referenceNodes: [...node.getOverloads(), node],
            },
          ]
        : [];
    }),
    ...sourceFile.getClasses().flatMap((node) => {
      const name = node.getName();
      return name
        ? [{ name, kind: "class" as const, node, referenceNodes: [node] }]
        : [];
    }),
    ...sourceFile.getInterfaces().map((node) => ({
      name: node.getName(),
      kind: "interface" as const,
      node,
      referenceNodes: [node],
    })),
    ...sourceFile.getTypeAliases().map((node) => ({
      name: node.getName(),
      kind: "type-alias" as const,
      node,
      referenceNodes: [node],
    })),
    ...sourceFile.getEnums().map((node) => ({
      name: node.getName(),
      kind: "enum" as const,
      node,
      referenceNodes: [node],
    })),
    ...sourceFile.getVariableStatements().flatMap((statement) =>
      statement.getDeclarations().map((node) => ({
        name: node.getName(),
        kind: "variable" as const,
        node,
        referenceNodes: [node],
      })),
    ),
  ].sort((left, right) =>
    `${left.node.getStart()}`.localeCompare(`${right.node.getStart()}`, "en", {
      numeric: true,
    }),
  );
  const declarationNames = new Set(declarations.map(({ name }) => name));
  const declarationNodes = new Map<string, Node[]>(
    [...declarationNames].map((name) => [
      name,
      declarations
        .filter((declaration) => declaration.name === name)
        .flatMap(({ referenceNodes }) => referenceNodes),
    ]),
  );
  const exportedNames = new Set(sourceFile.getExportedDeclarations().keys());

  const isReferenceIdentifier = (identifier: Node<ts.Identifier>): boolean => {
    const compilerNode = identifier.compilerNode;
    const parent = compilerNode.parent;
    if (
      (parent as ts.NamedDeclaration).name === compilerNode &&
      !ts.isShorthandPropertyAssignment(parent)
    )
      return false;
    if (
      ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) &&
        parent.propertyName === compilerNode) ||
      ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
        parent.label === compilerNode) ||
      (ts.isLabeledStatement(parent) && parent.label === compilerNode)
    )
      return false;
    return true;
  };

  const symbolReferences = (
    name: string,
    referenceNodes: readonly Node[],
  ): SymbolReferenceRecord[] => {
    const references = new Map<string, SymbolReferenceRecord>();
    const identifiers = referenceNodes.flatMap((node) =>
      node
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter(isReferenceIdentifier),
    );
    for (const identifier of identifiers) {
      const referenceName = identifier.getText();
      if (referenceName === "" || referenceName === name) continue;

      const symbol = identifier.getSymbol();
      const symbolDeclarations = symbol?.getDeclarations() ?? [];
      const directImportDeclaration = symbolDeclarations
        .map((declaration) =>
          declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration),
        )
        .find((declaration) => declaration?.getSourceFile() === sourceFile);
      const qualifiedParent = identifier.getParentIfKind(
        SyntaxKind.QualifiedName,
      );
      const propertyParent = identifier.getParentIfKind(
        SyntaxKind.PropertyAccessExpression,
      );
      const qualifier =
        qualifiedParent?.getRight() === identifier
          ? qualifiedParent.getLeft()
          : propertyParent?.getNameNode() === identifier
            ? propertyParent.getExpression()
            : undefined;
      const qualifierIdentifier =
        qualifier?.asKind(SyntaxKind.Identifier) ??
        qualifier?.getFirstDescendantByKind(SyntaxKind.Identifier);
      const namespaceImportDeclaration = qualifierIdentifier
        ?.getSymbol()
        ?.getDeclarations()
        .map((declaration) =>
          declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration),
        )
        .find((declaration) => declaration?.getSourceFile() === sourceFile);
      const importDeclaration =
        directImportDeclaration ?? namespaceImportDeclaration;
      let reference: SymbolReferenceRecord | undefined;

      if (importDeclaration) {
        const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
        const importedFile = imports.find(
          (item) => item.specifier === moduleSpecifier,
        )?.resolvedFile;
        const fallbackDeclarationName = symbolDeclarations
          .map((declaration) => declaration.asKind(SyntaxKind.ImportSpecifier))
          .find(
            (specifier) =>
              specifier?.getAliasNode()?.getText() === referenceName,
          )
          ?.getName();
        const targetDeclarations =
          terminalAliasedSymbol(symbol)?.getDeclarations() ?? [];
        const targetDeclaration = targetDeclarations.find(
          (declaration) =>
            declarationName(declaration) !== undefined &&
            selectedFiles.has(
              path.resolve(declaration.getSourceFile().getFilePath()),
            ),
        );
        const targetFile = targetDeclaration
          ? selectedFiles.get(
              path.resolve(targetDeclaration.getSourceFile().getFilePath()),
            )
          : undefined;
        const targetName = targetDeclaration
          ? declarationName(targetDeclaration)
          : fallbackDeclarationName;
        const localSpecifier =
          moduleSpecifier.startsWith(".") ||
          localModulePatterns.some((pattern) =>
            matchesModulePattern(moduleSpecifier, pattern),
          );
        const namespaceBinding = symbolDeclarations.some(
          (declaration) =>
            declaration.asKind(SyntaxKind.NamespaceImport) !== undefined,
        );
        if (namespaceBinding && targetName === undefined) continue;
        reference =
          (targetFile ?? importedFile)
            ? {
                name: referenceName,
                ...(targetName ? { declarationName: targetName } : {}),
                resolution: "internal",
                declarationFile: targetFile ?? importedFile!,
                moduleSpecifier,
              }
            : localSpecifier
              ? {
                  name: referenceName,
                  resolution: "unresolved",
                  moduleSpecifier,
                }
              : {
                  name: referenceName,
                  resolution: "external",
                  moduleSpecifier,
                };
      } else if (
        declarationNames.has(referenceName) &&
        symbolDeclarations.some(
          (declaration) =>
            declarationNodes
              .get(referenceName)
              ?.some(
                (topLevel) =>
                  topLevel.compilerNode === declaration.compilerNode,
              ) === true,
        )
      ) {
        reference = {
          name: referenceName,
          resolution: "local",
          declarationFile: relativePath,
        };
      } else if (symbolDeclarations.length === 0) {
        reference = { name: referenceName, resolution: "unresolved" };
      }

      if (reference) {
        const key = [
          reference.name,
          reference.declarationName ?? "",
          reference.resolution,
          reference.declarationFile ?? "",
          reference.moduleSpecifier ?? "",
        ].join("\0");
        references.set(key, reference);
      }
    }
    return [...references.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, reference]) => reference);
  };

  return declarations.map(({ name, kind, node, referenceNodes }) => ({
    name,
    kind,
    exported: exportedNames.has(name),
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    references: [
      ...new Set(
        node
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .map((identifier) => identifier.getText())
          .filter(
            (reference) =>
              reference !== name && declarationNames.has(reference),
          ),
      ),
    ].sort(),
    symbolReferences: symbolReferences(name, referenceNodes),
  }));
};

const topLevelStatements = (sourceFile: SourceFile) => {
  const statements = sourceFile.getStatements();
  const imports = statements.filter(
    (statement) =>
      statement.getKind() === SyntaxKind.ImportDeclaration ||
      statement.getKind() === SyntaxKind.ImportEqualsDeclaration,
  ).length;
  const reExports = statements.filter(
    (statement) => statement.getKind() === SyntaxKind.ExportDeclaration,
  ).length;
  return {
    imports,
    reExports,
    implementation: statements.length - imports - reExports,
  };
};

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
  const localModulePatterns = Object.keys(
    project.getCompilerOptions().paths ?? {},
  ).sort();
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

    const fileImports = sourceModuleSpecifiers(sourceFile)
      .map(({ specifier, typeOnly }) => ({
        fromFile: relativePath,
        specifier,
        typeOnly,
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
      declarations: topLevelDeclarations(
        sourceFile,
        relativePath,
        fileImports,
        selectedFiles,
        localModulePatterns,
      ),
      topLevelStatements: topLevelStatements(sourceFile),
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
