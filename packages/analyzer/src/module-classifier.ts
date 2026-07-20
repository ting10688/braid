import path from "node:path";
import type { ModuleKind, SourceFileRecord } from "@braid/core";
import { discoverWorkspaceLayout } from "./workspace-layout.js";

export interface ModuleClassification {
  id: string;
  kind: ModuleKind;
}

export interface ModuleClassificationFacts {
  publicEntrypoints?: readonly string[];
  barrelFiles?: readonly string[];
}

const infrastructureDirectories = new Set([
  "adapters",
  "internal",
  "platform",
  "runtime",
]);

const normalized = (filePath: string): string => filePath.replaceAll("\\", "/");

const belowSource = (filePath: string): string[] => {
  const segments = normalized(filePath).split("/");
  const sourceIndex = segments.lastIndexOf("src");
  return segments.slice(sourceIndex + 1);
};

const withoutSourceExtension = (filePath: string): string =>
  filePath.replace(/\.[cm]?[jt]sx?$/u, "");

export const classifyModuleIdentity = (
  filePath: string,
  facts: ModuleClassificationFacts = {},
): ModuleClassification => {
  const normalizedPath = normalized(filePath);
  const parts = belowSource(normalizedPath);
  const first = parts[0];
  const relativeStem = withoutSourceExtension(parts.join("/"));
  const publicEntrypoints = new Set(
    (facts.publicEntrypoints ?? []).map(normalized),
  );
  const barrelFiles = new Set((facts.barrelFiles ?? []).map(normalized));

  if (publicEntrypoints.has(normalizedPath))
    return { id: `entrypoint:${relativeStem}`, kind: "entrypoint" };
  if (parts.length === 1 && barrelFiles.has(normalizedPath))
    return { id: `barrel:${relativeStem}`, kind: "barrel" };
  if (!first || path.posix.extname(first))
    return { id: `root:${relativeStem}`, kind: "root-file" };
  if (first === "modules" && parts[1] && !path.posix.extname(parts[1]))
    return { id: `modules/${parts[1]}`, kind: "feature" };
  return {
    id: first,
    kind: infrastructureDirectories.has(first) ? "infrastructure" : "feature",
  };
};

export const classifyModule = (
  filePath: string,
  facts: ModuleClassificationFacts = {},
): string => classifyModuleIdentity(filePath, facts).id;

export const findBarrelFiles = (files: readonly SourceFileRecord[]): string[] =>
  files
    .filter(({ path: filePath, topLevelStatements }) => {
      const parts = belowSource(filePath);
      return (
        parts.length === 1 &&
        topLevelStatements !== undefined &&
        topLevelStatements.reExports >= 2 &&
        topLevelStatements.implementation === 0
      );
    })
    .map(({ path: filePath }) => normalized(filePath))
    .sort();

export const findPublicEntrypoints = async (
  projectRoot: string,
  files: readonly SourceFileRecord[],
): Promise<string[]> => [
  ...(
    await discoverWorkspaceLayout(
      projectRoot,
      files.map(({ path: filePath }) => filePath),
    )
  ).publicEntrypoints,
];

export const classifySourceFiles = (
  files: readonly SourceFileRecord[],
  publicEntrypoints: readonly string[],
): Map<string, ModuleClassification> => {
  const barrelFiles = findBarrelFiles(files);
  return new Map(
    files.map(({ path: filePath }) => [
      normalized(filePath),
      classifyModuleIdentity(filePath, { publicEntrypoints, barrelFiles }),
    ]),
  );
};
