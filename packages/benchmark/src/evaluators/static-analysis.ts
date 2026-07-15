import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { architectureConfigSchema, type ArchitectureConfig } from "@braid/core";
import { parse } from "yaml";
import type { ArchitectureMeasurement } from "../models/benchmark.js";

export interface IndependentImport {
  fromFile: string;
  toFile: string;
  fromModule: string;
  toModule: string;
  kind: "internal" | "external";
}

export interface IndependentFacts {
  architecture: ArchitectureMeasurement;
  files: ReadonlyMap<string, { lines: number; contents: string }>;
  modules: ReadonlySet<string>;
  moduleMetrics: ReadonlyMap<string, { files: number; exports: number }>;
  imports: readonly IndependentImport[];
  cycles: readonly string[][];
  config: ArchitectureConfig;
}

const linesOfCode = (contents: string): number =>
  contents.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== "" &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      trimmed !== "*/"
    );
  }).length;

const moduleFor = (file: string): string => {
  const belowSource = file
    .split("/")
    .slice(file.split("/").lastIndexOf("src") + 1);
  const first = belowSource[0];
  if (!first || /\.[^.]+$/u.test(first)) return "root";
  if (
    first === "modules" &&
    belowSource[1] &&
    !/\.[^.]+$/u.test(belowSource[1])
  )
    return `modules/${belowSource[1]}`;
  return first;
};

const specifiers = (contents: string): string[] => {
  // ponytail: independently re-derive static imports without sharing Braid's graph; add alias resolution when a qualified repository needs it.
  const values = new Set<string>();
  const pattern = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/gu;
  for (const match of contents.matchAll(pattern))
    if (match[1]) values.add(match[1]);
  return [...values].sort();
};

const resolveInternal = (
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null => {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  const candidates = [
    base,
    base.replace(/\.[cm]?js$/u, ".ts"),
    base.replace(/\.[cm]?js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
};

const stronglyConnected = (
  nodes: readonly string[],
  imports: readonly IndependentImport[],
): string[][] => {
  const adjacency = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const edge of imports)
    if (edge.kind === "internal" && edge.fromModule !== edge.toModule)
      adjacency.get(edge.fromModule)?.add(edge.toModule);
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    active.add(node);
    for (const target of [...(adjacency.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (active.has(target)) {
        low.set(node, Math.min(low.get(node)!, indices.get(target)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      active.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1) components.push(component.sort());
  };
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
};

export const analyzeFixture = async (
  root: string,
): Promise<IndependentFacts> => {
  const config = architectureConfigSchema.parse(
    parse(
      await readFile(path.join(root, ".braid", "architecture.yaml"), "utf8"),
    ),
  );
  const files = new Map<string, { lines: number; contents: string }>();
  for await (const file of glob(config.source.include, {
    cwd: root,
    exclude: config.source.exclude,
  })) {
    const normalized = file.replaceAll(path.sep, "/");
    if (/\.d\.[cm]?tsx?$/u.test(normalized)) continue;
    const contents = await readFile(path.join(root, file), "utf8");
    files.set(normalized, { lines: linesOfCode(contents), contents });
  }
  const knownFiles = new Set(files.keys());
  const imports: IndependentImport[] = [];
  let externalImports = 0;
  for (const [fromFile, source] of files) {
    for (const specifier of specifiers(source.contents)) {
      const toFile = resolveInternal(fromFile, specifier, knownFiles);
      if (toFile) {
        imports.push({
          fromFile,
          toFile,
          fromModule: moduleFor(fromFile),
          toModule: moduleFor(toFile),
          kind: "internal",
        });
      } else if (!specifier.startsWith(".")) {
        externalImports += 1;
        imports.push({
          fromFile,
          toFile: specifier,
          fromModule: moduleFor(fromFile),
          toModule: specifier,
          kind: "external",
        });
      }
    }
  }
  imports.sort((left, right) =>
    `${left.fromFile}\0${left.toFile}`.localeCompare(
      `${right.fromFile}\0${right.toFile}`,
    ),
  );
  const modules = new Set([...files.keys()].map(moduleFor));
  const cycles = stronglyConnected([...modules], imports);
  const moduleMetrics = new Map(
    [...modules].map((module) => {
      const moduleFiles = [...files.entries()].filter(
        ([file]) => moduleFor(file) === module,
      );
      return [
        module,
        {
          files: moduleFiles.length,
          exports: moduleFiles.reduce(
            (total, [, source]) =>
              total +
              [
                ...source.contents.matchAll(
                  /\bexport\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\b/gu,
                ),
              ].length,
            0,
          ),
        },
      ] as const;
    }),
  );
  return {
    architecture: {
      sourceFiles: files.size,
      sourceLinesOfCode: [...files.values()].reduce(
        (sum, file) => sum + file.lines,
        0,
      ),
      modules: modules.size,
      internalImports: imports.filter(({ kind }) => kind === "internal").length,
      externalImports,
      crossModuleImports: imports.filter(
        (edge) => edge.kind === "internal" && edge.fromModule !== edge.toModule,
      ).length,
      circularDependencies: cycles.length,
      oversizedFiles: [...files.values()].filter(
        ({ lines }) => lines > config.thresholds.oversized_file_lines,
      ).length,
      oversizedModules: [...moduleMetrics.values()].filter(
        (module) =>
          module.files > config.thresholds.oversized_module_files ||
          module.exports > config.thresholds.oversized_module_exports,
      ).length,
      publicEntrypoints: [...files.keys()].filter((file) =>
        /(?:^|\/)index\.tsx?$/u.test(file),
      ).length,
    },
    files,
    modules,
    moduleMetrics,
    imports,
    cycles,
    config,
  };
};

export interface NormalizedSourceFile {
  hash: string;
  lines: number;
}

export const normalizedSourceTree = async (
  root: string,
): Promise<ReadonlyMap<string, NormalizedSourceFile>> => {
  const files = new Map<string, NormalizedSourceFile>();
  for await (const file of glob(["src/**/*.ts", "src/**/*.tsx"], {
    cwd: root,
  })) {
    const normalized = file.replaceAll(path.sep, "/");
    const contents = await readFile(path.join(root, file), "utf8");
    files.set(normalized, {
      hash: createHash("sha256")
        .update(contents.replaceAll("\r\n", "\n"))
        .digest("hex"),
      lines: linesOfCode(contents),
    });
  }
  return files;
};
