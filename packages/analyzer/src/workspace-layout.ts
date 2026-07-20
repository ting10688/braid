import path from "node:path";
import { readFile } from "node:fs/promises";

export interface WorkspaceLayout {
  packageDirectoryForFile: ReadonlyMap<string, string>;
  publicEntrypoints: readonly string[];
  sourceForSpecifier: ReadonlyMap<string, string>;
}

interface PackageFiles {
  directory: string;
  files: string[];
  manifest: Record<string, unknown>;
}

const normalized = (value: string): string => value.replaceAll("\\", "/");

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

const sourceStem = (filePath: string): string => {
  const parts = normalized(filePath).split("/");
  return parts
    .slice(parts.lastIndexOf("src") + 1)
    .join("/")
    .replace(/\.[cm]?[jt]sx?$/u, "");
};

const packageReferences = (manifest: Record<string, unknown>): string[] =>
  stringsIn({
    exports: manifest.exports,
    main: manifest.main,
    module: manifest.module,
    browser: manifest.browser,
    types: manifest.types,
    bin: manifest.bin,
  }).map(referenceStem);

const matchingSource = (
  references: readonly string[],
  files: readonly string[],
): string | undefined => {
  const matches = new Set(
    references.flatMap((reference) => {
      const candidate = files
        .map((file) => ({ file, stem: sourceStem(file) }))
        .filter(
          ({ stem }) => reference === stem || reference.endsWith(`/${stem}`),
        )
        .sort(
          (left, right) =>
            right.stem.length - left.stem.length ||
            left.file.localeCompare(right.file),
        )[0];
      return candidate ? [candidate.file] : [];
    }),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
};

const readManifest = async (
  projectRoot: string,
  directory: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const contents = await readFile(
      path.join(projectRoot, directory, "package.json"),
      "utf8",
    );
    try {
      const parsed = JSON.parse(contents) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  } catch {
    return null;
  }
};

const packageDirectories = (filePath: string): string[] => {
  const directories: string[] = [];
  let current = path.posix.dirname(normalized(filePath));
  while (current !== ".") {
    directories.push(current);
    current = path.posix.dirname(current);
  }
  directories.push("");
  return directories;
};

const rootExportReferences = (manifest: Record<string, unknown>): string[] => {
  const exports = manifest.exports;
  const rootExport =
    exports !== null && typeof exports === "object" && !Array.isArray(exports)
      ? ((exports as Record<string, unknown>)["."] ??
        (Object.keys(exports).some((key) => key.startsWith("."))
          ? undefined
          : exports))
      : exports;
  return stringsIn([
    rootExport,
    manifest.types,
    manifest.module,
    manifest.main,
    manifest.browser,
  ]).map(referenceStem);
};

export const discoverWorkspaceLayout = async (
  projectRoot: string,
  selectedFiles: readonly string[],
): Promise<WorkspaceLayout> => {
  const files = [...new Set(selectedFiles.map(normalized))].sort();
  const manifestCache = new Map<
    string,
    Promise<Record<string, unknown> | null>
  >();
  const manifestAt = (directory: string) => {
    const cached = manifestCache.get(directory);
    if (cached) return cached;
    const manifest = readManifest(projectRoot, directory);
    manifestCache.set(directory, manifest);
    return manifest;
  };
  const packageDirectoryForFile = new Map<string, string>();
  const packages = new Map<string, PackageFiles>();

  for (const file of files) {
    let packageDirectory = "";
    let manifest: Record<string, unknown> = {};
    if (!file.split("/").includes("node_modules")) {
      for (const directory of packageDirectories(file)) {
        const candidate = await manifestAt(directory);
        if (candidate !== null) {
          packageDirectory = directory;
          manifest = candidate;
          break;
        }
      }
    }
    packageDirectoryForFile.set(file, packageDirectory);
    const existing = packages.get(packageDirectory);
    if (existing) existing.files.push(file);
    else
      packages.set(packageDirectory, {
        directory: packageDirectory,
        files: [file],
        manifest,
      });
  }

  const publicEntrypoints = new Set(
    files.filter((file) =>
      /(?:^|\/)src\/index(?:\.[^/]+)?\.[cm]?[jt]sx?$/u.test(file),
    ),
  );
  const sourceCandidates = new Map<string, Set<string>>();
  const addSourceCandidate = (
    specifier: string,
    source: string | undefined,
  ) => {
    if (!source) return;
    const candidates = sourceCandidates.get(specifier) ?? new Set<string>();
    candidates.add(source);
    sourceCandidates.set(specifier, candidates);
  };

  for (const packageFiles of [...packages.values()].sort((left, right) =>
    left.directory.localeCompare(right.directory),
  )) {
    const { files: ownedFiles, manifest } = packageFiles;
    for (const reference of packageReferences(manifest)) {
      const match = matchingSource([reference], ownedFiles);
      if (match) publicEntrypoints.add(match);
    }

    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    if (!name) continue;
    const packageIndex = ownedFiles.filter((file) =>
      /(?:^|\/)src\/index\.[cm]?[jt]sx?$/u.test(file),
    );
    addSourceCandidate(
      name,
      matchingSource(rootExportReferences(manifest), ownedFiles) ??
        (packageIndex.length === 1 ? packageIndex[0] : undefined),
    );

    const exports = manifest.exports;
    if (
      exports === null ||
      typeof exports !== "object" ||
      Array.isArray(exports)
    )
      continue;
    for (const [subpath, target] of Object.entries(exports).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (!subpath.startsWith("./") || subpath.includes("*")) continue;
      addSourceCandidate(
        `${name}/${subpath.slice(2)}`,
        matchingSource(stringsIn(target).map(referenceStem), ownedFiles),
      );
    }
  }

  return {
    packageDirectoryForFile,
    publicEntrypoints: [...publicEntrypoints].sort(),
    sourceForSpecifier: new Map(
      [...sourceCandidates.entries()]
        .filter(([, candidates]) => candidates.size === 1)
        .map(
          ([specifier, candidates]) =>
            [specifier, [...candidates][0]!] as const,
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};
