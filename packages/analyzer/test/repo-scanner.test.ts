import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArchitectureConfig,
  DEFAULT_ARCHITECTURE_CONFIG,
} from "@braid/core";
import { scanRepository } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("repository scanner", () => {
  it("honors include/exclude patterns and resolves aliases and index files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-scanner-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@domain/*": ["src/domain/*"] },
        },
      }),
    );
    await writeFile(
      path.join(root, "src", "domain", "index.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      path.join(root, "src", "index.ts"),
      'import { value } from "@domain/index"; export { value };\n',
    );
    await writeFile(
      path.join(root, "src", "ignored.test.ts"),
      "export const ignored = true;\n",
    );

    const config = parseArchitectureConfig(
      DEFAULT_ARCHITECTURE_CONFIG.replace(
        '    - "**/*.d.ts"',
        '    - "**/*.d.ts"\n    - "**/*.test.ts"',
      ),
    );
    const result = await scanRepository(root, config);

    expect(result.files.map((file) => file.path)).toEqual([
      "src/domain/index.ts",
      "src/index.ts",
    ]);
    expect(result.imports).toContainEqual({
      fromFile: "src/index.ts",
      specifier: "@domain/index",
      resolvedFile: "src/domain/index.ts",
      typeOnly: false,
    });
  });

  it("classifies deterministic declaration symbol references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-scanner-symbols-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          baseUrl: ".",
          paths: { "@missing/*": ["src/missing/*"] },
        },
      }),
    );
    await writeFile(
      path.join(root, "src", "dependencies.ts"),
      [
        "export default interface DefaultType { value: string }",
        "export interface InternalType { value: string }",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "barrel.ts"),
      'export type { InternalType as BarrelType } from "./dependencies.js";\n',
    );
    await writeFile(
      path.join(root, "src", "subject.ts"),
      [
        'import type DefaultAlias from "./dependencies.js";',
        'import type { InternalType as ImportedAlias } from "./dependencies.js";',
        'import type * as Models from "./dependencies.js";',
        'import type { BarrelType as BarrelAlias } from "./barrel.js";',
        'import type { MissingLocal } from "./missing.js";',
        'import type { MissingAlias } from "@missing/model";',
        'import type { ExternalType } from "external-package";',
        "interface LocalType { propertyName: string }",
        "interface Payload { value: string }",
        "const helper = (value: LocalType) => value.propertyName;",
        "export function primary(",
        "  input: LocalType,",
        "  internal: ImportedAlias,",
        "  external: ExternalType,",
        "  missing: MissingType,",
        "): Promise<LocalType> {",
        "  const propertyName = input.propertyName;",
        "  void internal.value;",
        "  void external.value;",
        "  void missing.value;",
        "  return Promise.resolve(helper({ propertyName }));",
        "}",
        "export function shadowed(helper: string): string {",
        "  return helper.toUpperCase();",
        "}",
        "export function aliases(",
        "  defaultValue: DefaultAlias,",
        "  namespaceValue: Models.InternalType,",
        "  barrelValue: BarrelAlias,",
        "  missingLocal: MissingLocal,",
        "  missingAlias: MissingAlias,",
        "): string {",
        "  return [defaultValue, namespaceValue, barrelValue, missingLocal, missingAlias].join();",
        "}",
        "export function overloaded(input: Payload): void;",
        "export function overloaded(input: string): void;",
        "export function overloaded(input: unknown): void { void input; }",
      ].join("\n"),
    );

    const config = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    const first = await scanRepository(root, config);
    const second = await scanRepository(root, config);
    const primary = first.files
      .find((file) => file.path === "src/subject.ts")
      ?.declarations?.find((declaration) => declaration.name === "primary");
    const shadowed = first.files
      .find((file) => file.path === "src/subject.ts")
      ?.declarations?.find((declaration) => declaration.name === "shadowed");
    const aliases = first.files
      .find((file) => file.path === "src/subject.ts")
      ?.declarations?.find((declaration) => declaration.name === "aliases");
    const overloaded = first.files
      .find((file) => file.path === "src/subject.ts")
      ?.declarations?.find((declaration) => declaration.name === "overloaded");

    expect(primary?.references).toEqual(["LocalType", "helper"]);
    expect(primary?.symbolReferences).toEqual([
      {
        name: "ExternalType",
        resolution: "external",
        moduleSpecifier: "external-package",
      },
      {
        name: "ImportedAlias",
        declarationName: "InternalType",
        resolution: "internal",
        declarationFile: "src/dependencies.ts",
        moduleSpecifier: "./dependencies.js",
      },
      {
        name: "LocalType",
        resolution: "local",
        declarationFile: "src/subject.ts",
      },
      { name: "MissingType", resolution: "unresolved" },
      {
        name: "helper",
        resolution: "local",
        declarationFile: "src/subject.ts",
      },
    ]);
    expect(shadowed?.symbolReferences).toEqual([]);
    expect(aliases?.symbolReferences).toEqual([
      {
        name: "BarrelAlias",
        declarationName: "InternalType",
        resolution: "internal",
        declarationFile: "src/dependencies.ts",
        moduleSpecifier: "./barrel.js",
      },
      {
        name: "DefaultAlias",
        declarationName: "DefaultType",
        resolution: "internal",
        declarationFile: "src/dependencies.ts",
        moduleSpecifier: "./dependencies.js",
      },
      {
        name: "InternalType",
        declarationName: "InternalType",
        resolution: "internal",
        declarationFile: "src/dependencies.ts",
        moduleSpecifier: "./dependencies.js",
      },
      {
        name: "MissingAlias",
        resolution: "unresolved",
        moduleSpecifier: "@missing/model",
      },
      {
        name: "MissingLocal",
        resolution: "unresolved",
        moduleSpecifier: "./missing.js",
      },
    ]);
    expect(overloaded?.references).toEqual([]);
    expect(overloaded?.symbolReferences).toEqual([
      {
        name: "Payload",
        resolution: "local",
        declarationFile: "src/subject.ts",
      },
    ]);
    expect(second.files).toEqual(first.files);
  });
});
