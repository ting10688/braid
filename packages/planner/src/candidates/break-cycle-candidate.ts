import { createHash } from "node:crypto";
import type {
  ArchitectureConfig,
  ArchitectureSnapshot,
  DependencyCycle,
  ImportEdge,
} from "@braid/core";
import {
  buildAdjacencyList,
  detectCycles,
  findStronglyConnectedComponents,
} from "@braid/analyzer";
import type { ProposalCandidate } from "../candidate.js";
import { protectedFiles } from "../path-policy.js";
import { PLANNER_VERSION } from "../proposal-id.js";

interface CycleEdge {
  fromModule: string;
  toModule: string;
  imports: ImportEdge[];
  importingFiles: string[];
  files: string[];
  publicEntrypoints: string[];
  protectedFiles: string[];
}

interface CycleRoot {
  signature: string;
  modules: string[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);

const canonicalCycle = (modules: readonly string[]): string[] => {
  const rotations = modules.map((_, index) => [
    ...modules.slice(index),
    ...modules.slice(0, index),
  ]);
  return (
    rotations.sort((left, right) =>
      compare(left.join("\0"), right.join("\0")),
    )[0] ?? [...modules]
  );
};

const moduleCycles = (imports: readonly ImportEdge[]): string[][] => {
  const edges = imports.filter(
    (edge) => edge.kind === "internal" && edge.fromModule !== edge.toModule,
  );
  return detectCycles(
    buildAdjacencyList(
      new Set(edges.flatMap((edge) => [edge.fromModule, edge.toModule])),
      edges.map((edge) => [edge.fromModule, edge.toModule] as const),
    ),
  );
};

const cycleRoots = (snapshot: ArchitectureSnapshot): CycleRoot[] => {
  const edges = snapshot.repository.imports.filter(
    (edge) => edge.kind === "internal" && edge.fromModule !== edge.toModule,
  );
  const adjacency = buildAdjacencyList(
    new Set(edges.flatMap((edge) => [edge.fromModule, edge.toModule])),
    edges.map((edge) => [edge.fromModule, edge.toModule] as const),
  );
  return findStronglyConnectedComponents(adjacency)
    .filter((modules) => modules.length > 1)
    .map((modules) => {
      const selected = new Set(modules);
      const relevantEdges = edges
        .filter(
          (edge) =>
            selected.has(edge.fromModule) && selected.has(edge.toModule),
        )
        .map(({ fromModule, toModule, fromFile, toFile }) => ({
          fromModule,
          toModule,
          fromFile,
          toFile,
        }))
        .sort((left, right) =>
          compare(
            `${left.fromModule}\0${left.toModule}\0${left.fromFile}\0${left.toFile}`,
            `${right.fromModule}\0${right.toModule}\0${right.fromFile}\0${right.toFile}`,
          ),
        );
      const signature = createHash("sha256")
        .update(
          JSON.stringify({
            plannerVersion: PLANNER_VERSION,
            snapshot: {
              configHash: snapshot.configHash,
              gitCommit: snapshot.gitCommit,
            },
            modules,
            edges: relevantEdges,
            files: [
              ...new Set(
                relevantEdges.flatMap(({ fromFile, toFile }) => [
                  fromFile,
                  toFile,
                ]),
              ),
            ].sort(compare),
          }),
        )
        .digest("hex")
        .slice(0, 12);
      return { signature: `CR-${signature}`, modules };
    });
};

const collectCycleEdges = (
  cycle: readonly string[],
  imports: readonly ImportEdge[],
  publicEntrypoints: readonly string[],
  protectedPaths: readonly string[],
): CycleEdge[] =>
  cycle.map((fromModule, index) => {
    const toModule = cycle[(index + 1) % cycle.length]!;
    const matching = imports
      .filter(
        (edge) =>
          edge.kind === "internal" &&
          edge.fromModule === fromModule &&
          edge.toModule === toModule,
      )
      .sort((left, right) =>
        compare(
          `${left.fromFile}\0${left.toFile}`,
          `${right.fromFile}\0${right.toFile}`,
        ),
      );
    const files = [
      ...new Set(matching.flatMap((edge) => [edge.fromFile, edge.toFile])),
    ].sort(compare);
    return {
      fromModule,
      toModule,
      imports: matching,
      importingFiles: [...new Set(matching.map((edge) => edge.fromFile))].sort(
        compare,
      ),
      files,
      publicEntrypoints: files.filter((file) =>
        publicEntrypoints.includes(file),
      ),
      protectedFiles: protectedFiles(files, protectedPaths),
    };
  });

const rankEdges = (edges: CycleEdge[]): CycleEdge[] =>
  [...edges].sort((left, right) => {
    const tuple = (edge: CycleEdge): Array<number | string> => [
      edge.importingFiles.length,
      edge.imports.length,
      edge.publicEntrypoints.length > 0 ? 1 : 0,
      edge.protectedFiles.length > 0 ? 1 : 0,
      `${edge.fromModule}\0${edge.toModule}`,
    ];
    const leftTuple = tuple(left);
    const rightTuple = tuple(right);
    for (let index = 0; index < leftTuple.length; index += 1) {
      const first = leftTuple[index]!;
      const second = rightTuple[index]!;
      const result =
        typeof first === "number" && typeof second === "number"
          ? first - second
          : compare(String(first), String(second));
      if (result !== 0) return result;
    }
    return 0;
  });

const suggestedStrategy = (
  selected: CycleEdge,
  imports: readonly ImportEdge[],
): "introduce-boundary" | "dependency-inversion" | "move-shared-contract" => {
  if (
    selected.files.every((file) =>
      /(?:^|\/)(?:contracts?|types?)(?:\/|[.-])/u.test(file),
    )
  )
    return "move-shared-contract";
  if (
    imports.some(
      (edge) =>
        edge.kind === "internal" &&
        edge.fromModule === selected.toModule &&
        edge.toModule === selected.fromModule,
    )
  )
    return "dependency-inversion";
  return "introduce-boundary";
};

const canonicalCycles = (cycles: readonly DependencyCycle[]): string[][] => {
  const unique = new Map<string, string[]>();
  for (const cycle of cycles) {
    const modules = canonicalCycle([...new Set(cycle.modules)]);
    if (modules.length < 2) continue;
    unique.set(modules.join("\0"), modules);
  }
  return [...unique.values()].sort((left, right) =>
    compare(left.join("\0"), right.join("\0")),
  );
};

export const breakCycleCandidates = (
  snapshot: ArchitectureSnapshot,
  config: ArchitectureConfig,
): ProposalCandidate[] => {
  const imports = snapshot.repository.imports;
  const cyclesBefore = moduleCycles(imports).length;
  const roots = cycleRoots(snapshot);

  return canonicalCycles(snapshot.repository.cycles).flatMap((cycle) => {
    const root = roots.find(({ modules }) =>
      cycle.every((module) => modules.includes(module)),
    );
    if (!root) return [];
    if (
      root.modules.every((id) => {
        const kind = snapshot.repository.modules.find(
          (module) => module.id === id,
        )?.kind;
        return ["root-file", "entrypoint", "barrel"].includes(kind ?? "");
      })
    )
      return [];
    const cycleEdges = collectCycleEdges(
      cycle,
      imports,
      snapshot.repository.publicEntrypoints,
      config.protected_paths,
    );
    if (cycleEdges.some((edge) => edge.imports.length === 0)) return [];
    const cycleFiles = [
      ...new Set(cycleEdges.flatMap((edge) => edge.files)),
    ].sort(compare);
    const publicEntrypoints = cycleFiles.filter((file) =>
      snapshot.repository.publicEntrypoints.includes(file),
    );
    const protectedCycleFiles = protectedFiles(
      cycleFiles,
      config.protected_paths,
    );
    const moduleSurfaceFiles = cycleFiles.filter((file) => {
      const module = snapshot.repository.modules.find(({ paths }) =>
        paths.includes(file),
      );
      return module?.kind === "entrypoint" || module?.kind === "barrel";
    });

    return rankEdges(cycleEdges).map((selected) => {
      const remainingImports = imports.filter(
        (edge) =>
          !(
            edge.kind === "internal" &&
            edge.fromModule === selected.fromModule &&
            edge.toModule === selected.toModule
          ),
      );
      const cyclesAfter = moduleCycles(remainingImports).length;
      const strategy = suggestedStrategy(selected, imports);
      return {
        schemaVersion: 1 as const,
        snapshotId: snapshot.id,
        type: "break-cycle" as const,
        title: `Break ${selected.fromModule} → ${selected.toModule} cycle edge`,
        summary:
          "Remove the lowest-coupling module edge supported by the current import graph.",
        affectedFiles: cycleFiles,
        affectedModules: [...cycle].sort(compare),
        target: {
          type: "break-cycle" as const,
          cycleModules: cycle,
          cycleFiles,
          selectedEdge: {
            fromModule: selected.fromModule,
            toModule: selected.toModule,
            files: selected.files,
          },
          suggestedStrategy: strategy,
          rootCauseSignature: root.signature,
          rootCauseModules: root.modules,
        },
        evidence: [
          {
            type: "dependency-cycle" as const,
            modules: cycle,
            files: cycleFiles,
          },
          {
            type: "cycle-edge" as const,
            fromModule: selected.fromModule,
            toModule: selected.toModule,
            importingFiles: selected.importingFiles,
            importCount: selected.imports.length,
          },
          ...(publicEntrypoints.length > 0
            ? [
                {
                  type: "public-entrypoint-impact" as const,
                  files: publicEntrypoints,
                },
              ]
            : []),
          ...(protectedCycleFiles.length > 0
            ? [
                {
                  type: "protected-path-impact" as const,
                  files: protectedCycleFiles,
                },
              ]
            : []),
          ...(config.constraints.circular_dependencies === "forbidden"
            ? [
                {
                  type: "architecture-constraint" as const,
                  constraint: "circular_dependencies",
                  details: "Configured as forbidden.",
                },
              ]
            : []),
        ],
        expectedImpact: {
          simulated: [
            {
              metric: "circularDependencies" as const,
              direction:
                cyclesAfter < cyclesBefore
                  ? ("decrease" as const)
                  : ("unchanged" as const),
              delta: cyclesAfter - cyclesBefore,
              rationale: `Graph simulation removes ${selected.fromModule} → ${selected.toModule} and changes detected module cycles from ${cyclesBefore} to ${cyclesAfter}.`,
            },
          ],
          estimated: [],
          unknowns: [
            "The implementation strategy may introduce a new contract or boundary module.",
            "Final file and public API changes require migration execution planning.",
          ],
        },
        preconditions: [
          "The selected import edge still exists when migration execution begins.",
          "Repository tests pass before migration execution.",
        ],
        constraints: [
          "Preserve runtime behavior and existing public import paths.",
          "Do not introduce a replacement dependency cycle.",
        ],
        rollbackStrategy:
          "Restore the original module edge through a compatibility contract before reverting the boundary migration.",
        severity:
          config.constraints.circular_dependencies === "forbidden" ? 3 : 2,
        confidence: 3,
        expectedBenefit: cyclesAfter < cyclesBefore ? 3 : 1,
        protectedFiles: protectedCycleFiles,
        publicEntrypoints,
        moduleSurfaceFiles,
        cycleLength: cycle.length,
      };
    });
  });
};
