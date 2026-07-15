import { createHash } from "node:crypto";
import {
  executionReadinessResultSchema,
  type ArchitectureConfig,
  type ArchitectureSnapshot,
  type ExecutionReadinessResult,
  type ExecutionReadinessSymbol,
  type ExecutionReadinessSymbolLocator,
  type ExternalDependency,
  type MigrationProposal,
  type PredictedCycleRisk,
  type PredictedImportEdge,
  type ReadinessReason,
  type ReadinessWarning,
  type RetainedDependency,
  type SymbolReferenceRecord,
  type UnresolvedDependency,
} from "@braid/core";
import { classifyModule } from "@braid/analyzer";

export const READINESS_ALGORITHM_VERSION = "1.0.0";
export const READINESS_REJECTION_EXIT_CODE = 13;

export interface EvaluateExecutionReadinessInput {
  proposal: MigrationProposal;
  snapshot: ArchitectureSnapshot;
  config: ArchitectureConfig;
  configHash: string;
  sourceFingerprint: string;
}

type SymbolNode = ExecutionReadinessSymbol & {
  references: SymbolReferenceRecord[];
  legacyReferences: boolean;
};

interface ReadinessCore {
  primarySymbols: ExecutionReadinessSymbol[];
  requiredCompanionSymbols: ExecutionReadinessSymbol[];
  retainedDependencies: RetainedDependency[];
  externalDependencies: ExternalDependency[];
  unresolvedDependencies: UnresolvedDependency[];
  predictedImportEdges: PredictedImportEdge[];
  predictedCycleRisks: PredictedCycleRisk[];
  warnings: ReadinessWarning[];
  blockingReasons: ReadinessReason[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compare);
const locatorKey = (locator: ExecutionReadinessSymbolLocator): string =>
  `${locator.file}\0${locator.name}`;
const symbolKey = (symbol: ExecutionReadinessSymbol): string =>
  locatorKey(symbol);
const sortLocators = <T extends ExecutionReadinessSymbolLocator>(
  values: readonly T[],
): T[] =>
  [...values].sort((left, right) =>
    compare(locatorKey(left), locatorKey(right)),
  );

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

const globExpression = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`, "u");
};

const matchesConfiguredPath = (
  file: string,
  configuredPath: string,
): boolean => {
  const pattern = configuredPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (/[*?]/u.test(pattern)) return globExpression(pattern).test(file);
  const prefix = pattern.replace(/\/$/u, "");
  return file === prefix || file.startsWith(`${prefix}/`);
};

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

const addGroupedReference = <
  T extends { referencedBy: ExecutionReadinessSymbolLocator[] },
>(
  map: Map<string, T>,
  key: string,
  create: () => T,
  from: ExecutionReadinessSymbolLocator,
): void => {
  const item = map.get(key) ?? create();
  item.referencedBy = sortLocators([
    ...item.referencedBy,
    ...(!item.referencedBy.some(
      (locator) => locatorKey(locator) === locatorKey(from),
    )
      ? [from]
      : []),
  ]);
  map.set(key, item);
};

const predictedEdgesFor = (
  movedKeys: ReadonlySet<string>,
  nodes: ReadonlyMap<string, SymbolNode>,
  moduleFor: (file: string) => string,
  sourceModule: string,
  destinationModule: string,
  preserveExistingImportPaths: boolean,
): PredictedImportEdge[] => {
  const grouped = new Map<string, PredictedImportEdge>();
  const add = (
    fromModule: string,
    toModule: string,
    reason: PredictedImportEdge["reason"],
    symbol: string,
  ): void => {
    if (fromModule === toModule) return;
    const key = `${fromModule}\0${toModule}\0${reason}`;
    const current = grouped.get(key);
    grouped.set(key, {
      fromModule,
      toModule,
      reason,
      symbols: uniqueSorted([...(current?.symbols ?? []), symbol]),
    });
  };

  if (preserveExistingImportPaths)
    add(
      sourceModule,
      destinationModule,
      "moved-symbol-reference",
      "<public-path>",
    );

  for (const node of nodes.values()) {
    const nodeMoved = movedKeys.has(symbolKey(node));
    for (const reference of node.references) {
      if (!["local", "internal"].includes(reference.resolution)) continue;
      const targetFile = reference.declarationFile ?? node.file;
      const targetKey = locatorKey({
        file: targetFile,
        name: reference.declarationName ?? reference.name,
      });
      const dependencyName = reference.declarationName ?? reference.name;
      const targetMoved = movedKeys.has(targetKey);
      if (!nodeMoved && targetMoved)
        add(
          moduleFor(node.file),
          destinationModule,
          "moved-symbol-reference",
          dependencyName,
        );
      if (nodeMoved && !targetMoved)
        add(
          destinationModule,
          moduleFor(targetFile),
          "retained-dependency",
          dependencyName,
        );
    }
  }
  return [...grouped.values()].sort((left, right) =>
    compare(
      `${left.fromModule}\0${left.toModule}\0${left.reason}`,
      `${right.fromModule}\0${right.toModule}\0${right.reason}`,
    ),
  );
};

const adjacencyFor = (
  snapshot: ArchitectureSnapshot,
  predicted: readonly PredictedImportEdge[],
  movedKeys: ReadonlySet<string>,
  nodes: ReadonlyMap<string, SymbolNode>,
): Map<string, string[]> => {
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (from === to) return;
    const targets = adjacency.get(from) ?? new Set<string>();
    targets.add(to);
    adjacency.set(from, targets);
    if (!adjacency.has(to)) adjacency.set(to, new Set());
  };
  const fileByPath = new Map(
    snapshot.repository.files.map((file) => [file.path, file] as const),
  );
  for (const edge of snapshot.repository.imports)
    if (
      edge.kind === "internal" &&
      edge.fromModule !== edge.toModule &&
      (() => {
        const file = fileByPath.get(edge.fromFile);
        const declarations = [...nodes.values()].filter(
          (node) => node.file === edge.fromFile,
        );
        if (
          !file ||
          !file.topLevelStatements ||
          declarations.length === 0 ||
          declarations.some(({ legacyReferences }) => legacyReferences) ||
          file.topLevelStatements.implementation !== declarations.length ||
          file.topLevelStatements.reExports > 0 ||
          file.topLevelStatements.imports > file.importedFiles.length
        )
          return true;
        const references = declarations.flatMap((node) =>
          node.references.flatMap((reference) => {
            if (!["local", "internal"].includes(reference.resolution))
              return [];
            const targetFile = reference.declarationFile ?? node.file;
            if (targetFile !== edge.toFile) return [];
            return [
              {
                sourceMoved: movedKeys.has(symbolKey(node)),
                targetMoved: movedKeys.has(
                  locatorKey({
                    file: targetFile,
                    name: reference.declarationName ?? reference.name,
                  }),
                ),
              },
            ];
          }),
        );
        if (references.length === 0) return true;
        return references.some(
          ({ sourceMoved, targetMoved }) => !sourceMoved && !targetMoved,
        );
      })()
    )
      add(edge.fromModule, edge.toModule);
  for (const edge of predicted) add(edge.fromModule, edge.toModule);
  return new Map(
    [...adjacency.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([module, targets]) => [module, [...targets].sort(compare)]),
  );
};

const pathBetween = (
  adjacency: ReadonlyMap<string, readonly string[]>,
  start: string,
  target: string,
): string[] | undefined => {
  const visit = (
    current: string,
    path: string[],
    seen: Set<string>,
  ): string[] | undefined => {
    if (current === target) return path;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      const found = visit(next, [...path, next], new Set([...seen, next]));
      if (found) return found;
    }
    return;
  };
  return visit(start, [start], new Set([start]));
};

const cycleRisksFor = (
  snapshot: ArchitectureSnapshot,
  predicted: readonly PredictedImportEdge[],
  movedKeys: ReadonlySet<string>,
  nodes: ReadonlyMap<string, SymbolNode>,
): PredictedCycleRisk[] => {
  const adjacency = adjacencyFor(snapshot, predicted, movedKeys, nodes);
  const risks = predicted.flatMap((edge) => {
    const returnPath = pathBetween(adjacency, edge.toModule, edge.fromModule);
    if (!returnPath) return [];
    const modules = uniqueSorted([edge.fromModule, ...returnPath]);
    return [{ modules, edges: [edge] }];
  });
  const unique = new Map<string, PredictedCycleRisk>();
  for (const risk of risks) {
    const key = risk.modules.join("\0");
    const current = unique.get(key);
    unique.set(key, {
      modules: risk.modules,
      edges: [...(current?.edges ?? []), ...risk.edges]
        .filter(
          (edge, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.fromModule === edge.fromModule &&
                candidate.toModule === edge.toModule &&
                candidate.reason === edge.reason,
            ) === index,
        )
        .sort((left, right) =>
          compare(
            `${left.fromModule}\0${left.toModule}\0${left.reason}`,
            `${right.fromModule}\0${right.toModule}\0${right.reason}`,
          ),
        ),
    });
  }
  return [...unique.values()].sort((left, right) =>
    compare(left.modules.join("\0"), right.modules.join("\0")),
  );
};

const coreFor = (input: EvaluateExecutionReadinessInput): ReadinessCore => {
  if (input.proposal.target.type !== "extract-module")
    throw new Error(
      "Execution readiness supports extract-module proposals only",
    );
  const target = input.proposal.target;
  const moduleByFile = new Map(
    input.snapshot.repository.modules.flatMap((module) =>
      module.paths.map((file) => [file, module.id] as const),
    ),
  );
  const moduleFor = (file: string): string =>
    moduleByFile.get(file) ?? classifyModule(file);
  const nodes = new Map<string, SymbolNode>();
  for (const file of input.snapshot.repository.files)
    for (const declaration of file.declarations ?? []) {
      const legacyReferences = declaration.symbolReferences === undefined;
      const references: SymbolReferenceRecord[] =
        declaration.symbolReferences ??
        declaration.references.map((name) => ({
          name,
          resolution: "local" as const,
          declarationFile: file.path,
        }));
      const node: SymbolNode = {
        file: file.path,
        name: declaration.name,
        kind: declaration.kind,
        module: moduleFor(file.path),
        exported: declaration.exported,
        references: [...references].sort((left, right) =>
          compare(
            `${left.resolution}\0${left.declarationFile ?? ""}\0${left.moduleSpecifier ?? ""}\0${left.declarationName ?? ""}\0${left.name}`,
            `${right.resolution}\0${right.declarationFile ?? ""}\0${right.moduleSpecifier ?? ""}\0${right.declarationName ?? ""}\0${right.name}`,
          ),
        ),
        legacyReferences,
      };
      nodes.set(symbolKey(node), node);
    }

  const blockingReasons: ReadinessReason[] = [];
  const warnings: ReadinessWarning[] = [];
  const addBlock = (reason: ReadinessReason): void => {
    if (
      !blockingReasons.some(
        (item) => item.code === reason.code && item.message === reason.message,
      )
    )
      blockingReasons.push(reason);
  };
  const addWarning = (warning: ReadinessWarning): void => {
    if (
      !warnings.some(
        (item) =>
          item.code === warning.code && item.message === warning.message,
      )
    )
      warnings.push(warning);
  };

  const primarySymbols = target.candidateSymbols.flatMap((name) => {
    const symbol = nodes.get(locatorKey({ file: target.sourceFile, name }));
    if (symbol) return [symbol];
    addBlock({
      code: "primary-symbol-unresolved",
      message: `Primary symbol ${name} cannot be resolved in ${target.sourceFile}.`,
      files: [target.sourceFile],
      symbols: [name],
    });
    return [];
  });
  const primaryKeys = new Set(primarySymbols.map(symbolKey));
  const approvedCompanionKeys = new Set(
    (target.approvedCompanionSymbols ?? []).map(({ file, symbol }) =>
      locatorKey({ file, name: symbol }),
    ),
  );
  const required = new Map<string, SymbolNode>();

  const expandRequired = (includeApproved: boolean): void => {
    let changed = true;
    while (changed) {
      changed = false;
      const closure = new Set([
        ...primaryKeys,
        ...(includeApproved ? approvedCompanionKeys : []),
        ...required.keys(),
      ]);
      const predicted = predictedEdgesFor(
        closure,
        nodes,
        moduleFor,
        target.sourceModule,
        target.suggestedModuleName,
        input.config.constraints.preserve_existing_import_paths,
      );
      const cyclicRetainedModules = new Set(
        cycleRisksFor(input.snapshot, predicted, closure, nodes).flatMap(
          (risk) =>
            risk.edges
              .filter((edge) => edge.reason === "retained-dependency")
              .map((edge) => edge.toModule),
        ),
      );
      for (const key of [...closure].sort(compare)) {
        const node = nodes.get(key);
        if (!node) continue;
        for (const reference of node.references) {
          if (!["local", "internal"].includes(reference.resolution)) continue;
          const declarationFile = reference.declarationFile ?? node.file;
          const dependencyKey = locatorKey({
            file: declarationFile,
            name: reference.declarationName ?? reference.name,
          });
          if (primaryKeys.has(dependencyKey) || required.has(dependencyKey))
            continue;
          const dependency = nodes.get(dependencyKey);
          if (!dependency) continue;
          const mustMove =
            declarationFile === target.sourceFile ||
            !dependency.exported ||
            cyclicRetainedModules.has(moduleFor(declarationFile));
          if (mustMove) {
            required.set(dependencyKey, dependency);
            changed = true;
          }
        }
      }
    }
  };
  expandRequired(false);
  expandRequired(true);

  const fullClosure = new Set([
    ...primaryKeys,
    ...approvedCompanionKeys,
    ...required.keys(),
  ]);
  const approvedMove = new Set([...primaryKeys, ...approvedCompanionKeys]);
  const retained = new Map<string, RetainedDependency>();
  const external = new Map<string, ExternalDependency>();
  const unresolved = new Map<string, UnresolvedDependency>();
  for (const key of [...fullClosure].sort(compare)) {
    const node = nodes.get(key);
    if (!node) continue;
    if (node.legacyReferences)
      addWarning({
        code: "legacy-reference-evidence",
        message: `Symbol ${node.name} uses legacy reference evidence.`,
        files: [node.file],
        symbols: [node.name],
      });
    const from = { file: node.file, name: node.name };
    for (const reference of node.references) {
      if (reference.resolution === "external") {
        const package_ = packageName(
          reference.moduleSpecifier ?? reference.name,
        );
        addGroupedReference(
          external,
          `${package_}\0${reference.name}`,
          () => ({ name: reference.name, package: package_, referencedBy: [] }),
          from,
        );
        continue;
      }
      if (reference.resolution === "unresolved") {
        addGroupedReference(
          unresolved,
          reference.name,
          () => ({
            name: reference.name,
            referencedBy: [],
            reason: "Analyzer could not resolve the declaration dependency.",
          }),
          from,
        );
        continue;
      }
      const declarationFile = reference.declarationFile ?? node.file;
      const dependencyKey = locatorKey({
        file: declarationFile,
        name: reference.declarationName ?? reference.name,
      });
      if (fullClosure.has(dependencyKey)) continue;
      const dependency = nodes.get(dependencyKey);
      if (!dependency) {
        addGroupedReference(
          unresolved,
          dependencyKey,
          () => ({
            name: reference.name,
            referencedBy: [],
            reason: `Resolved ${reference.resolution} declaration is absent from analyzer evidence.`,
          }),
          from,
        );
        continue;
      }
      addGroupedReference(
        retained,
        dependencyKey,
        () => ({ symbol: dependency, referencedBy: [] }),
        from,
      );
    }
  }

  const requiredCompanionSymbols = sortLocators([...required.values()]);
  for (const symbol of requiredCompanionSymbols) {
    const key = symbolKey(symbol);
    if (!approvedCompanionKeys.has(key))
      addBlock({
        code: "companion-not-authorized",
        message: `Required companion ${symbol.name} in ${symbol.file} is outside the approved proposal evidence.`,
        files: [symbol.file],
        symbols: [symbol.name],
      });
  }
  for (const key of [...approvedCompanionKeys].sort(compare)) {
    const approved = nodes.get(key);
    if (!approved) {
      const [file = target.sourceFile, name = key] = key.split("\0");
      addBlock({
        code: "required-local-declaration-unresolved",
        message: `Approved companion ${name} cannot be resolved in ${file}.`,
        files: [file],
        symbols: [name],
      });
    } else if (!required.has(key))
      addWarning({
        code: "approved-companion-not-required",
        message: `Approved companion ${approved.name} is not required by symbol closure.`,
        files: [approved.file],
        symbols: [approved.name],
      });
  }

  if (unresolved.size > 0)
    addBlock({
      code: "required-local-declaration-unresolved",
      message: `Symbol closure contains ${unresolved.size} unresolved declaration ${unresolved.size === 1 ? "dependency" : "dependencies"}.`,
      files: uniqueSorted(
        [...unresolved.values()].flatMap((item) =>
          item.referencedBy.map(({ file }) => file),
        ),
      ),
      symbols: uniqueSorted([...unresolved.values()].map(({ name }) => name)),
    });

  const budgetKeys = new Set([...fullClosure, ...approvedCompanionKeys]);
  if (budgetKeys.size > input.config.migration.maximumSymbols)
    addBlock({
      code: "closure-symbol-budget-exceeded",
      message: `Symbol closure requires ${budgetKeys.size} symbols; configured maximum is ${input.config.migration.maximumSymbols}.`,
      files: uniqueSorted([...budgetKeys].map((key) => key.split("\0")[0]!)),
      symbols: uniqueSorted([...budgetKeys].map((key) => key.split("\0")[1]!)),
    });
  const closureFiles = new Set(
    [...budgetKeys].map((key) => key.split("\0")[0]!),
  );
  const closureFileCount = closureFiles.size + 1;
  if (closureFileCount > input.config.migration.maximumChangedFiles)
    addBlock({
      code: "closure-file-budget-exceeded",
      message: `Symbol closure requires ${closureFileCount} source/destination files; configured maximum is ${input.config.migration.maximumChangedFiles}.`,
      files: [...closureFiles].sort(compare),
      symbols: [],
    });

  for (const symbol of [
    ...requiredCompanionSymbols,
    ...[...approvedCompanionKeys].flatMap((key) => nodes.get(key) ?? []),
  ]) {
    if (input.snapshot.repository.publicEntrypoints.includes(symbol.file))
      addBlock({
        code: "public-entrypoint-companion",
        message: `Companion ${symbol.name} requires a public entrypoint change in ${symbol.file}.`,
        files: [symbol.file],
        symbols: [symbol.name],
      });
    if (
      input.config.protected_paths.some((pattern) =>
        matchesConfiguredPath(symbol.file, pattern),
      )
    )
      addBlock({
        code: "protected-companion",
        message: `Companion ${symbol.name} requires protected path ${symbol.file}.`,
        files: [symbol.file],
        symbols: [symbol.name],
      });
  }

  const predictedImportEdges = predictedEdgesFor(
    approvedMove,
    nodes,
    moduleFor,
    target.sourceModule,
    target.suggestedModuleName,
    input.config.constraints.preserve_existing_import_paths,
  );
  const predictedCycleRisks = cycleRisksFor(
    input.snapshot,
    predictedImportEdges,
    approvedMove,
    nodes,
  );
  const reverseEdges = predictedImportEdges.filter(
    (edge) =>
      edge.fromModule === target.suggestedModuleName &&
      edge.toModule === target.sourceModule,
  );
  if (reverseEdges.length > 0)
    addBlock({
      code: "predictable-reverse-dependency",
      message: `Approved symbols predict a reverse dependency from ${target.suggestedModuleName} to ${target.sourceModule}.`,
      files: [target.sourceFile],
      symbols: uniqueSorted(reverseEdges.flatMap(({ symbols }) => symbols)),
    });
  if (predictedCycleRisks.length > 0)
    addBlock({
      code: "predicted-cycle",
      message: `Approved symbols predict ${predictedCycleRisks.length} new cycle risk${predictedCycleRisks.length === 1 ? "" : "s"}.`,
      files: [target.sourceFile],
      symbols: uniqueSorted(
        predictedCycleRisks.flatMap(({ edges }) =>
          edges.flatMap(({ symbols }) => symbols),
        ),
      ),
    });

  if (retained.size > 0)
    addWarning({
      code: "retained-local-dependency",
      message: `${retained.size} repository-local dependency${retained.size === 1 ? " remains" : " dependencies remain"} in place.`,
      files: uniqueSorted(
        [...retained.values()].map(({ symbol }) => symbol.file),
      ),
      symbols: uniqueSorted(
        [...retained.values()].map(({ symbol }) => symbol.name),
      ),
    });

  return {
    primarySymbols: sortLocators(primarySymbols),
    requiredCompanionSymbols,
    retainedDependencies: [...retained.values()].sort((left, right) =>
      compare(symbolKey(left.symbol), symbolKey(right.symbol)),
    ),
    externalDependencies: [...external.values()].sort((left, right) =>
      compare(
        `${left.package}\0${left.name}`,
        `${right.package}\0${right.name}`,
      ),
    ),
    unresolvedDependencies: [...unresolved.values()].sort((left, right) =>
      compare(left.name, right.name),
    ),
    predictedImportEdges,
    predictedCycleRisks,
    warnings: warnings.sort((left, right) =>
      compare(
        `${left.code}\0${left.message}`,
        `${right.code}\0${right.message}`,
      ),
    ),
    blockingReasons: blockingReasons.sort((left, right) =>
      compare(
        `${left.code}\0${left.message}`,
        `${right.code}\0${right.message}`,
      ),
    ),
  };
};

export const evaluateExecutionReadiness = (
  input: EvaluateExecutionReadinessInput,
): ExecutionReadinessResult => {
  const first = coreFor(input);
  const repeated = coreFor(input);
  const firstResultHash = sha256(first);
  const repeatedResultHash = sha256(repeated);
  if (firstResultHash !== repeatedResultHash)
    first.blockingReasons.push({
      code: "nondeterministic-closure",
      message:
        "Repeated symbol-closure evaluation produced different evidence.",
      files: [],
      symbols: [],
    });
  const state =
    first.blockingReasons.length > 0
      ? "not-ready"
      : first.warnings.length > 0
        ? "ready-with-warnings"
        : "ready";
  return executionReadinessResultSchema.parse({
    schemaVersion: 1,
    proposalId: input.proposal.id,
    fingerprints: {
      snapshotId: input.snapshot.id,
      configHash: input.configHash,
      sourceFingerprint: input.sourceFingerprint,
    },
    state,
    ...first,
    deterministicEvidence: {
      algorithmVersion: READINESS_ALGORITHM_VERSION,
      inputHash: sha256({
        proposal: input.proposal,
        repository: input.snapshot.repository,
        maximumChangedFiles: input.config.migration.maximumChangedFiles,
        maximumSymbols: input.config.migration.maximumSymbols,
        protectedPaths: input.config.protected_paths,
        preserveExistingImportPaths:
          input.config.constraints.preserve_existing_import_paths,
      }),
      firstResultHash,
      repeatedResultHash,
      stable: firstResultHash === repeatedResultHash,
    },
  });
};
