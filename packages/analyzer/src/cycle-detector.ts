import type { DependencyCycle, ImportEdge } from "@braid/core";
import { buildAdjacencyList } from "./import-graph.js";

const canonicalCycle = (cycle: string[]): string[] => {
  const rotations = cycle.map((_, index) => [
    ...cycle.slice(index),
    ...cycle.slice(0, index),
  ]);
  return (
    rotations.sort((left, right) =>
      left.join("\0").localeCompare(right.join("\0")),
    )[0] ?? cycle
  );
};

export const detectCycles = (
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] => {
  // ponytail: exhaustive enumeration suits local source graphs; replace only if profiling shows scale pain.
  const found = new Map<string, string[]>();

  const walk = (
    start: string,
    current: string,
    path: string[],
    visited: Set<string>,
  ): void => {
    for (const next of adjacency.get(current) ?? []) {
      if (next === start) {
        const cycle = canonicalCycle(path);
        found.set(cycle.join("\0"), cycle);
      } else if (!visited.has(next)) {
        visited.add(next);
        walk(start, next, [...path, next], visited);
        visited.delete(next);
      }
    }
  };

  for (const start of [...adjacency.keys()].sort())
    walk(start, start, [start], new Set([start]));
  return [...found.values()].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
};

export const findStronglyConnectedComponents = (
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] => {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    const index = nextIndex++;
    indices.set(node, index);
    lowLinks.set(node, index);
    stack.push(node);
    stacked.add(node);

    for (const target of [...(adjacency.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(target)!),
        );
      } else if (stacked.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      stacked.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component.sort());
  };

  for (const node of [...adjacency.keys()].sort())
    if (!indices.has(node)) visit(node);
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
};

export const findDependencyCycles = (
  imports: ImportEdge[],
): DependencyCycle[] => {
  const internal = imports.filter((edge) => edge.kind === "internal");
  const fileAdjacency = buildAdjacencyList(
    new Set(internal.flatMap((edge) => [edge.fromFile, edge.toFile])),
    internal.map((edge) => [edge.fromFile, edge.toFile] as const),
  );
  const fileCycles = detectCycles(fileAdjacency).map((files) => ({
    files,
    modules: [
      ...new Set(
        files.map(
          (file) => internal.find((edge) => edge.fromFile === file)?.fromModule,
        ),
      ),
    ].filter((module): module is string => module !== undefined),
  }));

  const crossModule = internal.filter(
    (edge) => edge.fromModule !== edge.toModule,
  );
  const moduleAdjacency = buildAdjacencyList(
    new Set(crossModule.flatMap((edge) => [edge.fromModule, edge.toModule])),
    crossModule.map((edge) => [edge.fromModule, edge.toModule] as const),
  );
  const moduleCycles = detectCycles(moduleAdjacency).map((modules) => {
    const files = new Set<string>();
    for (let index = 0; index < modules.length; index += 1) {
      const from = modules[index]!;
      const to = modules[(index + 1) % modules.length]!;
      for (const edge of crossModule.filter(
        (candidate) =>
          candidate.fromModule === from && candidate.toModule === to,
      )) {
        files.add(edge.fromFile);
        files.add(edge.toFile);
      }
    }
    return { modules, files: [...files].sort() };
  });

  const unique = new Map<string, DependencyCycle>();
  for (const cycle of [...fileCycles, ...moduleCycles]) {
    const normalized = { modules: [...cycle.modules], files: [...cycle.files] };
    unique.set(
      `${normalized.modules.join("\0")}|${normalized.files.join("\0")}`,
      normalized,
    );
  }
  return [...unique.values()].sort((left, right) =>
    `${left.modules.join("\0")}|${left.files.join("\0")}`.localeCompare(
      `${right.modules.join("\0")}|${right.files.join("\0")}`,
    ),
  );
};
