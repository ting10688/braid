import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ModuleKind, SourceFileRecord } from "@braid/core";

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

const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(stringsIn);
  return [];
};

const referenceStem = (value: string): string =>
  normalized(value)
    .replace(/^\.\//u, "")
    .replace(/\.(?:d\.)?[cm]?[jt]sx?$/u, "");

const sourceStem = (filePath: string): string =>
  withoutSourceExtension(belowSource(filePath).join("/"));

export const findPublicEntrypoints = async (
  projectRoot: string,
  files: readonly SourceFileRecord[],
): Promise<string[]> => {
  const entrypoints = new Set(
    files
      .map(({ path: filePath }) => normalized(filePath))
      .filter((filePath) =>
        /(?:^|\/)src\/index(?:\.[^/]+)?\.[cm]?[jt]sx?$/u.test(filePath),
      ),
  );
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const references = stringsIn({
      exports: packageJson.exports,
      main: packageJson.main,
      module: packageJson.module,
      browser: packageJson.browser,
      types: packageJson.types,
      bin: packageJson.bin,
    }).map(referenceStem);
    const candidates = files.map(({ path: filePath }) => ({
      path: normalized(filePath),
      stem: sourceStem(filePath),
    }));
    for (const reference of references) {
      const match = candidates
        .filter(
          ({ stem }) => reference === stem || reference.endsWith(`/${stem}`),
        )
        .sort(
          (left, right) =>
            right.stem.length - left.stem.length ||
            left.path.localeCompare(right.path),
        )[0];
      if (match) entrypoints.add(match.path);
    }
  } catch {
    // A package manifest is optional; top-level index facts still apply.
  }
  return [...entrypoints].sort();
};

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
