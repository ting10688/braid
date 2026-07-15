import type { ImportEdge, SourceFileRecord } from "@braid/core";
import type { ScannedImport } from "./repo-scanner.js";
import { classifyModule } from "./module-classifier.js";

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

export const buildImportGraph = (
  files: SourceFileRecord[],
  scannedImports: ScannedImport[],
): ImportEdge[] => {
  const knownFiles = new Set(files.map((file) => file.path));

  return scannedImports
    .filter(
      (item) => item.resolvedFile !== null || !item.specifier.startsWith("."),
    )
    .map((item): ImportEdge => {
      const internal =
        item.resolvedFile !== null && knownFiles.has(item.resolvedFile);
      const toFile = internal
        ? item.resolvedFile!
        : packageName(item.specifier);
      return {
        fromFile: item.fromFile,
        toFile,
        fromModule: classifyModule(item.fromFile),
        toModule: internal ? classifyModule(toFile) : toFile,
        kind: internal ? "internal" : "external",
      };
    })
    .sort((left, right) =>
      `${left.fromFile}\0${left.toFile}\0${left.kind}`.localeCompare(
        `${right.fromFile}\0${right.toFile}\0${right.kind}`,
      ),
    );
};

export const buildAdjacencyList = (
  nodes: Iterable<string>,
  edges: Iterable<readonly [string, string]>,
): Map<string, string[]> => {
  const adjacency = new Map(
    [...nodes].map((node) => [node, new Set<string>()]),
  );
  for (const [from, to] of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from)!.add(to);
  }
  return new Map(
    [...adjacency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([node, targets]) => [node, [...targets].sort()]),
  );
};
