import path from "node:path";
import type {
  ArchitectureConfig,
  ArchitectureSnapshot,
  SourceFileRecord,
  TopLevelDeclarationRecord,
} from "@braid/core";
import { classifyModule } from "@braid/analyzer";
import type { ProposalCandidate } from "../candidate.js";
import { protectedFiles } from "../path-policy.js";
import { tokenizeSymbolName } from "./symbol-tokenizer.js";

interface SymbolCluster {
  token: string;
  declarations: TopLevelDeclarationRecord[];
  internalReferenceCount: number;
  selectedLines: number;
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);

const sourceTokens = (file: SourceFileRecord, module: string): Set<string> =>
  new Set([
    ...tokenizeSymbolName(
      path.posix.basename(file.path, path.posix.extname(file.path)),
    ),
    ...tokenizeSymbolName(module.split("/").at(-1) ?? module),
  ]);

const isGeneratedFile = (file: string): boolean =>
  /(?:^|\/)(?:__generated__|generated)(?:\/|$)|\.generated\.[cm]?tsx?$/u.test(
    file,
  );

const clustersFor = (
  file: SourceFileRecord,
  sourceModule: string,
  minimumSize: number,
): SymbolCluster[] => {
  const declarations = file.declarations ?? [];
  const ignoredTokens = sourceTokens(file, sourceModule);
  const byToken = new Map<string, TopLevelDeclarationRecord[]>();
  for (const declaration of declarations) {
    for (const token of tokenizeSymbolName(declaration.name)) {
      if (ignoredTokens.has(token)) continue;
      const group = byToken.get(token) ?? [];
      group.push(declaration);
      byToken.set(token, group);
    }
  }

  return [...byToken.entries()]
    .flatMap(([token, grouped]) => {
      const unique = [
        ...new Map(grouped.map((item) => [item.name, item])).values(),
      ].sort((left, right) => compare(left.name, right.name));
      if (unique.length < minimumSize || unique.length === declarations.length)
        return [];
      const names = new Set(unique.map((item) => item.name));
      return [
        {
          token,
          declarations: unique,
          internalReferenceCount: unique.reduce(
            (total, declaration) =>
              total +
              declaration.references.filter((reference) => names.has(reference))
                .length,
            0,
          ),
          selectedLines: unique.reduce(
            (total, declaration) =>
              total + declaration.endLine - declaration.startLine + 1,
            0,
          ),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.internalReferenceCount - left.internalReferenceCount ||
        left.declarations.length - right.declarations.length ||
        right.selectedLines - left.selectedLines ||
        compare(left.token, right.token),
    );
};

export const extractModuleCandidates = (
  snapshot: ArchitectureSnapshot,
  config: ArchitectureConfig,
): ProposalCandidate[] =>
  snapshot.repository.files
    .filter(
      (file) =>
        file.linesOfCode > config.thresholds.oversized_file_lines &&
        !file.isTestFile &&
        !/\.d\.[cm]?tsx?$/u.test(file.path) &&
        !isGeneratedFile(file.path) &&
        !/(?:^|\/)index\.[cm]?tsx?$/u.test(file.path) &&
        (file.declarations?.length ?? 0) >=
          config.planner.min_symbol_cluster_size + 1,
    )
    .flatMap((file) => {
      const sourceModule = classifyModule(file.path);
      const cluster = clustersFor(
        file,
        sourceModule,
        config.planner.min_symbol_cluster_size,
      )[0];
      if (!cluster) return [];
      const symbols = cluster.declarations
        .map((declaration) => declaration.name)
        .sort(compare);
      const protectedSource = protectedFiles(
        [file.path],
        config.protected_paths,
      );
      const publicEntrypoints = snapshot.repository.publicEntrypoints.includes(
        file.path,
      )
        ? [file.path]
        : [];
      const moduleRecord = snapshot.repository.modules.find(
        (module) => module.id === sourceModule,
      );
      const mayClearThreshold =
        file.linesOfCode - cluster.selectedLines <=
        config.thresholds.oversized_file_lines;

      return [
        {
          schemaVersion: 1 as const,
          snapshotId: snapshot.id,
          type: "extract-module" as const,
          title: `Extract ${cluster.token} responsibilities from ${path.posix.basename(file.path)}`,
          summary:
            "Extract a bounded declaration cluster identified by shared names and internal references.",
          affectedFiles: [file.path],
          affectedModules: [sourceModule],
          target: {
            type: "extract-module" as const,
            sourceFile: file.path,
            sourceModule,
            candidateSymbols: symbols,
            suggestedModuleName: cluster.token,
          },
          evidence: [
            {
              type: "oversized-file" as const,
              file: file.path,
              actualLines: file.linesOfCode,
              thresholdLines: config.thresholds.oversized_file_lines,
            },
            {
              type: "symbol-cluster" as const,
              sourceFile: file.path,
              symbols,
              sharedTokens: [cluster.token],
              internalReferenceCount: cluster.internalReferenceCount,
            },
            ...(moduleRecord &&
            (moduleRecord.fileCount >
              config.thresholds.oversized_module_files ||
              moduleRecord.exportedSymbolCount >
                config.thresholds.oversized_module_exports)
              ? [
                  {
                    type: "oversized-module" as const,
                    module: sourceModule,
                    actualFiles: moduleRecord.fileCount,
                    actualExports: moduleRecord.exportedSymbolCount,
                    fileThreshold: config.thresholds.oversized_module_files,
                    exportThreshold: config.thresholds.oversized_module_exports,
                  },
                ]
              : []),
            ...(publicEntrypoints.length > 0
              ? [
                  {
                    type: "public-entrypoint-impact" as const,
                    files: publicEntrypoints,
                  },
                ]
              : []),
            ...(protectedSource.length > 0
              ? [
                  {
                    type: "protected-path-impact" as const,
                    files: protectedSource,
                  },
                ]
              : []),
          ],
          expectedImpact: {
            simulated: [],
            estimated: [
              {
                metric: "oversizedFiles" as const,
                direction: mayClearThreshold
                  ? ("decrease" as const)
                  : ("unknown" as const),
                rationale: mayClearThreshold
                  ? `Removing the selected declaration spans may place the source below ${config.thresholds.oversized_file_lines} lines; caller rewrites are not simulated.`
                  : "The selected declaration spans reduce responsibility concentration, but may not clear the configured line threshold.",
              },
            ],
            unknowns: [
              "Exact cross-module import changes depend on caller rewrites.",
              `The suggested module name '${cluster.token}' is inferred only from identifiers.`,
            ],
          },
          preconditions: [
            "The selected declarations and references still match this snapshot.",
            "Repository tests pass before migration execution.",
          ],
          constraints: [
            "Preserve runtime behavior and existing public import paths.",
            "Keep unselected declarations in the source module.",
          ],
          rollbackStrategy:
            "Revert the isolated extraction migration and restore the original declarations and imports.",
          severity: 2,
          confidence: cluster.internalReferenceCount > 0 ? 3 : 2,
          expectedBenefit: mayClearThreshold ? 2 : 1,
          protectedFiles: protectedSource,
          publicEntrypoints,
        },
      ];
    });
