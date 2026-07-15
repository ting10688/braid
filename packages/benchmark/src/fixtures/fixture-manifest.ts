import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { configHash, loadArchitectureConfig } from "@braid/core";
import type {
  BenchmarkProtocol,
  BenchmarkSuite,
  FixtureManifest,
  RunManifest,
} from "../models/benchmark.js";
import { loadRepositoryManifest } from "../repositories/repository-materializer.js";
import { benchmarkAssetPath } from "./fixture-loader.js";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const normalizedJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalizedJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const ignoredDirectory = (relative: string): boolean =>
  /(?:^|\/)(?:\.git|node_modules|dist|build|coverage)(?:\/|$)|^\.braid\/state(?:\/|$)/u.test(
    relative,
  );

const fixtureFiles = async (
  root: string,
  relative = "",
): Promise<Array<{ path: string; contentHash: string }>> => {
  const files: Array<{ path: string; contentHash: string }> = [];
  for (const entry of (
    await readdir(path.join(root, relative), {
      withFileTypes: true,
    })
  ).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(
      relative.replaceAll(path.sep, "/"),
      entry.name,
    );
    if (entry.isDirectory()) {
      if (!ignoredDirectory(child))
        files.push(...(await fixtureFiles(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child,
        contentHash: sha256(await readFile(path.join(root, child))),
      });
    }
  }
  return files;
};

const emptyExpectationHash = sha256("");

interface ExecutionPolicy {
  correctnessRepetitions: number;
  timingRepetitions: number;
  warmupRuns: number;
  timeoutMs: number;
}

export const resolvedExecution = (
  protocol: BenchmarkProtocol,
  suite: BenchmarkSuite,
): ExecutionPolicy => ({
  correctnessRepetitions:
    suite.execution.correctnessRepetitions ?? protocol.correctnessRepetitions,
  timingRepetitions:
    suite.execution.timingRepetitions ?? protocol.timingRepetitions,
  warmupRuns: suite.execution.warmupRuns ?? protocol.warmupRuns,
  timeoutMs: suite.execution.timeoutMs ?? protocol.defaultTimeoutMs,
});

export const createFixtureManifest = async (
  benchmarksRoot: string,
  suite: BenchmarkSuite,
  protocol: BenchmarkProtocol,
): Promise<{
  manifest: FixtureManifest;
  configurationHash: string;
  execution: ExecutionPolicy;
  repositories: NonNullable<RunManifest["repositories"]>;
}> => {
  const fixtures: FixtureManifest["fixtures"] = [];
  const repositories: NonNullable<RunManifest["repositories"]> = [];
  const add = async (
    fixtureId: string,
    fixturePath: string,
    expectationPath?: string,
  ): Promise<void> => {
    const root = benchmarkAssetPath(benchmarksRoot, fixturePath);
    fixtures.push({
      fixtureId,
      files: await fixtureFiles(root),
      configurationHash: configHash(
        await loadArchitectureConfig(
          path.join(root, ".braid", "architecture.yaml"),
        ),
      ),
      expectationFileHash: expectationPath
        ? sha256(
            await readFile(benchmarkAssetPath(benchmarksRoot, expectationPath)),
          )
        : emptyExpectationHash,
    });
  };

  for (const benchmarkCase of suite.cases) {
    if (benchmarkCase.type === "proposal")
      await add(
        benchmarkCase.id,
        benchmarkCase.fixture,
        benchmarkCase.expectationFile,
      );
    else if (benchmarkCase.type === "repository-proposal") {
      const repository = await loadRepositoryManifest(
        benchmarksRoot,
        benchmarkCase.repositoryId,
      );
      const root = benchmarkAssetPath(
        benchmarksRoot,
        path.join("repositories", repository.id),
      );
      fixtures.push({
        fixtureId: benchmarkCase.id,
        files: await fixtureFiles(root),
        configurationHash: configHash(
          await loadArchitectureConfig(
            path.join(root, repository.braidConfiguration.file),
          ),
        ),
        expectationFileHash: sha256(
          await readFile(
            benchmarkAssetPath(benchmarksRoot, benchmarkCase.expectationFile),
          ),
        ),
      });
      repositories.push({
        id: repository.id,
        url: repository.repository.url,
        commit: repository.repository.commit,
        licenseHash: repository.license.contentHash,
        lockfileHash: repository.packageManager.lockfileHash,
        sourceManifestHash: repository.source.manifestHash,
        braidConfigurationHash: repository.braidConfiguration.hash,
        qualificationStatus: repository.qualification.status,
        sourceFiles: repository.source.fileCount,
        sourceLinesOfCode: repository.source.linesOfCode,
        moduleCount: repository.source.moduleCount,
        installStatus: repository.qualification.install.status,
        buildStatus: repository.qualification.build.status,
        testStatus: repository.qualification.test.status,
        braidAnalysisStatus: repository.qualification.braidAnalysis.status,
      });
    } else if (benchmarkCase.type === "static-comparison") {
      await add(`${benchmarkCase.id}:before`, benchmarkCase.beforeFixture);
      await add(`${benchmarkCase.id}:after`, benchmarkCase.afterFixture);
    }
  }
  fixtures.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  const withoutHash = {
    schemaVersion: 1 as const,
    manifestVersion: "1.0.0",
    suiteId: suite.id,
    suiteVersion: suite.suiteVersion,
    fixtures,
  };
  const execution = resolvedExecution(protocol, suite);
  return {
    manifest: {
      ...withoutHash,
      hash: sha256(normalizedJson(withoutHash)),
    },
    configurationHash: sha256(
      normalizedJson({
        suiteVersion: suite.suiteVersion,
        cases: suite.cases,
        execution,
        normalizationRules: protocol.normalizationRules,
      }),
    ),
    execution,
    repositories: repositories.sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
};

export const manifestCompatibilityFields = (
  manifest: RunManifest,
): Readonly<Record<string, string | number>> => ({
  protocolVersion: manifest.protocolVersion,
  suiteId: manifest.suiteId,
  suiteVersion: manifest.suiteVersion,
  expectationVersion: manifest.expectationVersion,
  fixtureManifestVersion: manifest.fixtureManifestVersion,
  fixtureManifestHash: manifest.fixtureManifestHash,
  configurationHash: manifest.configurationHash,
  repositories: normalizedJson(manifest.repositories ?? []),
  correctnessRepetitions: manifest.execution.correctnessRepetitions,
  timeoutMs: manifest.execution.timeoutMs,
});
