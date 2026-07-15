import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepository } from "@braid/analyzer";
import {
  architectureConfigSchema,
  configHash,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_CONFIG,
  executionConfigHash,
  migrationConfigHash,
  migrationProposalSchema,
  parseArchitectureConfig,
  repositoryModelSchema,
  type ArchitectureConfig,
  type ImportEdge,
  type SourceFileRecord,
  type SymbolReferenceRecord,
  type TopLevelDeclarationRecord,
} from "@braid/core";
import { evaluateExecutionReadiness } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SOURCE_FINGERPRINT = "a".repeat(64);

const configFor = (preserveExistingImportPaths = false): ArchitectureConfig =>
  architectureConfigSchema.parse({
    ...parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG),
    constraints: {
      ...parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG).constraints,
      preserve_existing_import_paths: preserveExistingImportPaths,
    },
    migration: {
      enabled: true,
      maximumChangedFiles: 8,
      maximumSymbols: 20,
      validation: { commands: [] },
    },
  });

const declaration = (
  name: string,
  exported: boolean,
  references: SymbolReferenceRecord[] = [],
  kind: TopLevelDeclarationRecord["kind"] = "function",
): TopLevelDeclarationRecord => ({
  name,
  kind,
  exported,
  startLine: 1,
  endLine: 1,
  references: references.map((reference) => reference.name),
  symbolReferences: references,
});

const sourceFile = (
  file: string,
  declarations: TopLevelDeclarationRecord[],
  importedFiles: string[] = [],
): SourceFileRecord => ({
  path: file,
  linesOfCode: declarations.length,
  exportedSymbols: declarations
    .filter(({ exported }) => exported)
    .map(({ name }) => name),
  importedFiles,
  isTestFile: false,
  declarations,
  topLevelStatements: {
    imports: importedFiles.length,
    reExports: 0,
    implementation: declarations.length,
  },
});

const inputFor = ({
  files,
  moduleByFile,
  imports = [],
  candidateSymbols = ["Primary", "Secondary"],
  approvedCompanionSymbols = [],
  preserveExistingImportPaths = false,
}: {
  files: SourceFileRecord[];
  moduleByFile: Record<string, string>;
  imports?: ImportEdge[];
  candidateSymbols?: string[];
  approvedCompanionSymbols?: Array<{ file: string; symbol: string }>;
  preserveExistingImportPaths?: boolean;
}) => {
  const config = configFor(preserveExistingImportPaths);
  const modules = [...new Set(Object.values(moduleByFile))].sort().map((id) => {
    const paths = Object.entries(moduleByFile)
      .filter(([, module]) => module === id)
      .map(([file]) => file)
      .sort();
    return {
      id,
      kind: "feature" as const,
      paths,
      fileCount: paths.length,
      exportedSymbolCount: files
        .filter((file) => paths.includes(file.path))
        .flatMap((file) => file.declarations ?? [])
        .filter(({ exported }) => exported).length,
      incomingDependencies: [],
      outgoingDependencies: [],
    };
  });
  const repository = repositoryModelSchema.parse({
    projectRoot: "/project",
    language: "typescript",
    files,
    modules,
    imports,
    cycles: [],
    publicEntrypoints: [],
  });
  const snapshot = createArchitectureSnapshot({
    projectRoot: repository.projectRoot,
    gitCommit: null,
    configHash: configHash(config),
    migrationConfigHash: migrationConfigHash(config),
    sourceFingerprint: SOURCE_FINGERPRINT,
    repository,
    metrics: {
      totalSourceFiles: files.length,
      totalModules: modules.length,
      totalInternalImports: imports.length,
      totalExternalImports: 0,
      crossModuleImports: imports.length,
      circularDependencies: 0,
      oversizedFiles: 0,
      oversizedModules: 0,
      publicEntrypointCount: 0,
    },
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  const sourceFilePath = files[0]!.path;
  const sourceModule = moduleByFile[sourceFilePath]!;
  const proposal = migrationProposalSchema.parse({
    schemaVersion: 1,
    id: "P-EM-cafebabe",
    snapshotId: snapshot.id,
    type: "extract-module",
    title: "Readiness regression",
    summary: "Exercise deterministic symbol closure.",
    affectedFiles: [sourceFilePath],
    affectedModules: [sourceModule],
    target: {
      type: "extract-module",
      sourceFile: sourceFilePath,
      sourceModule,
      candidateSymbols,
      ...(approvedCompanionSymbols.length > 0
        ? { approvedCompanionSymbols }
        : {}),
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "symbol-cluster",
        sourceFile: sourceFilePath,
        symbols: candidateSymbols,
        sharedTokens: ["readiness"],
        internalReferenceCount: 1,
      },
    ],
    expectedImpact: { simulated: [], estimated: [], unknowns: [] },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "easy", factors: ["Synthetic fixture."] },
    preconditions: [],
    constraints: [],
    rollbackStrategy: "Restore source declarations.",
    ranking: {
      severity: 1,
      confidence: 3,
      expectedBenefit: 1,
      riskPenalty: 0,
      deterministicTieBreaker: "P-EM-cafebabe",
    },
  });
  return {
    proposal,
    snapshot,
    config,
    configHash: executionConfigHash(config),
    sourceFingerprint: SOURCE_FINGERPRINT,
  };
};

describe("execution readiness regressions", () => {
  it("analyzes every approved companion dependency", () => {
    const source = "src/orders/feature.ts";
    const input = inputFor({
      files: [
        sourceFile(source, [
          declaration("Primary", true),
          declaration("Secondary", true),
          declaration("Extra", true, [
            { name: "MissingLocal", resolution: "unresolved" },
          ]),
        ]),
      ],
      moduleByFile: { [source]: "orders" },
      approvedCompanionSymbols: [{ file: source, symbol: "Extra" }],
    });

    const result = evaluateExecutionReadiness(input);

    expect(result.state).toBe("not-ready");
    expect(result.requiredCompanionSymbols).toEqual([]);
    expect(result.unresolvedDependencies.map(({ name }) => name)).toEqual([
      "MissingLocal",
    ]);
  });

  it("removes a post-move import edge when all bindings target moved symbols", () => {
    const source = "src/orders/feature.ts";
    const consumer = "src/notification/consumer.ts";
    const input = inputFor({
      files: [
        sourceFile(source, [
          declaration("Primary", true),
          declaration("Secondary", true),
        ]),
        sourceFile(
          consumer,
          [
            declaration("Consumer", true, [
              {
                name: "Primary",
                resolution: "internal",
                declarationFile: source,
              },
            ]),
          ],
          [source],
        ),
      ],
      moduleByFile: { [source]: "orders", [consumer]: "notification" },
      imports: [
        {
          fromFile: consumer,
          toFile: source,
          fromModule: "notification",
          toModule: "orders",
          kind: "internal",
          typeOnly: false,
        },
      ],
      preserveExistingImportPaths: true,
    });

    const result = evaluateExecutionReadiness(input);

    expect(result.state).toBe("ready");
    expect(result.predictedCycleRisks).toEqual([]);
  });

  it("retains an import edge with opaque top-level symbol usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-readiness-edge-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src", "orders"), { recursive: true });
    await mkdir(path.join(root, "src", "notification"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
      }),
    );
    await writeFile(
      path.join(root, "src", "orders", "feature.ts"),
      [
        "export const Primary = () => 1;",
        "export const Secondary = () => 2;",
        "export const Retained = 3;",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "notification", "consumer.ts"),
      [
        'import { Primary, Retained } from "../orders/feature.js";',
        "export const Consumer = () => Primary();",
        "void Retained;",
      ].join("\n"),
    );
    const config = configFor(true);
    const analysis = await analyzeRepository(root, config);
    const snapshot = createArchitectureSnapshot({
      projectRoot: root,
      gitCommit: null,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      sourceFingerprint: SOURCE_FINGERPRINT,
      repository: analysis.repository,
      metrics: analysis.metrics,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const sourceFilePath = "src/orders/feature.ts";
    const sourceModule = "orders";
    const seed = inputFor({
      files: [
        sourceFile(sourceFilePath, [
          declaration("Primary", true),
          declaration("Secondary", true),
        ]),
      ],
      moduleByFile: { [sourceFilePath]: sourceModule },
    }).proposal;
    const proposal = migrationProposalSchema.parse({
      ...seed,
      snapshotId: snapshot.id,
      affectedFiles: [sourceFilePath],
      affectedModules: [sourceModule],
      target: {
        ...seed.target,
        sourceFile: sourceFilePath,
        sourceModule,
      },
    });

    const result = evaluateExecutionReadiness({
      proposal,
      snapshot,
      config,
      configHash: executionConfigHash(config),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });

    expect(result.state).toBe("not-ready");
    expect(result.blockingReasons.map(({ code }) => code)).toContain(
      "predicted-cycle",
    );
  });

  it("uses module-qualified cycle evidence for same-named declarations", () => {
    const source = "src/orders/feature.ts";
    const aContract = "src/a/contract.ts";
    const aReturn = "src/a/return.ts";
    const bContract = "src/b/contract.ts";
    const existing = "src/notification/existing.ts";
    const input = inputFor({
      files: [
        sourceFile(source, [
          declaration("Primary", true, [
            {
              name: "AContract",
              declarationName: "Contract",
              resolution: "internal",
              declarationFile: aContract,
            },
            {
              name: "BContract",
              declarationName: "Contract",
              resolution: "internal",
              declarationFile: bContract,
            },
          ]),
          declaration("Secondary", true),
        ]),
        sourceFile(aContract, [declaration("Contract", true, [], "interface")]),
        sourceFile(
          aReturn,
          [
            declaration("ReturnPath", true, [
              {
                name: "Existing",
                resolution: "internal",
                declarationFile: existing,
              },
            ]),
          ],
          [existing],
        ),
        sourceFile(bContract, [declaration("Contract", true, [], "interface")]),
        sourceFile(existing, [declaration("Existing", true)]),
      ],
      moduleByFile: {
        [source]: "orders",
        [aContract]: "module-a",
        [aReturn]: "module-a",
        [bContract]: "module-b",
        [existing]: "notification",
      },
      imports: [
        {
          fromFile: aReturn,
          toFile: existing,
          fromModule: "module-a",
          toModule: "notification",
          kind: "internal",
          typeOnly: false,
        },
      ],
      approvedCompanionSymbols: [{ file: aContract, symbol: "Contract" }],
    });

    const result = evaluateExecutionReadiness(input);

    expect(result.state).toBe("ready-with-warnings");
    expect(
      result.requiredCompanionSymbols.map(({ file, name }) => ({ file, name })),
    ).toEqual([{ file: aContract, name: "Contract" }]);
    expect(result.predictedCycleRisks).toEqual([]);
  });

  it("carries overload and missing-local analyzer facts into readiness", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "braid-readiness-analysis-"),
    );
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
      }),
    );
    await writeFile(
      path.join(root, "src", "subject.ts"),
      [
        'import type { MissingLocal } from "./missing.js";',
        "interface Payload { value: string }",
        "export function Primary(input: Payload): void;",
        "export function Primary(input: MissingLocal): void;",
        "export function Primary(input: unknown): void { void input; }",
        "export function Secondary(): void {}",
      ].join("\n"),
    );
    const config = configFor();
    const analysis = await analyzeRepository(root, config);
    const snapshot = createArchitectureSnapshot({
      projectRoot: root,
      gitCommit: null,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      sourceFingerprint: SOURCE_FINGERPRINT,
      repository: analysis.repository,
      metrics: analysis.metrics,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const sourceModule = snapshot.repository.modules.find((module) =>
      module.paths.includes("src/subject.ts"),
    )!.id;
    const seed = inputFor({
      files: snapshot.repository.files,
      moduleByFile: { "src/subject.ts": sourceModule },
    }).proposal;
    const proposal = migrationProposalSchema.parse({
      ...seed,
      snapshotId: snapshot.id,
      affectedModules: [sourceModule],
      target: {
        ...seed.target,
        sourceModule,
      },
    });

    const result = evaluateExecutionReadiness({
      proposal,
      snapshot,
      config,
      configHash: executionConfigHash(config),
      sourceFingerprint: SOURCE_FINGERPRINT,
    });

    expect(result.state).toBe("not-ready");
    expect(result.requiredCompanionSymbols.map(({ name }) => name)).toEqual([
      "Payload",
    ]);
    expect(result.unresolvedDependencies.map(({ name }) => name)).toEqual([
      "MissingLocal",
    ]);
  });
});
