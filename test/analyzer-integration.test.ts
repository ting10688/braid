import path from "node:path";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeRepository } from "@braid/analyzer";
import {
  architectureSnapshotSchema,
  configHash,
  createArchitectureSnapshot,
  loadArchitectureConfig,
} from "@braid/core";
import { CONFIG_FILE } from "@braid/shared";
import { JsonSnapshotStore } from "@braid/store";

const sourceFixture = fileURLToPath(
  new URL("../examples/bloated-saas", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("bloated SaaS analysis", () => {
  it("produces and persists equivalent deterministic analysis content", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "braid-integration-"));
    temporaryDirectories.push(parent);
    const projectRoot = path.join(parent, "bloated-saas");
    await cp(sourceFixture, projectRoot, {
      recursive: true,
      filter: (source) => !source.includes("/dist"),
    });
    const config = await loadArchitectureConfig(
      path.join(projectRoot, CONFIG_FILE),
    );

    const first = await analyzeRepository(projectRoot, config);
    const second = await analyzeRepository(projectRoot, config);
    expect(first.repository.files.map((file) => file.path)).toEqual([
      "src/index.ts",
      "src/orders/index.ts",
      "src/orders/order-service.ts",
      "src/shared/money.ts",
      "src/users/index.ts",
      "src/users/user-service.ts",
    ]);
    expect(first.metrics).toEqual({
      totalSourceFiles: 6,
      totalModules: 4,
      totalInternalImports: 7,
      totalExternalImports: 1,
      crossModuleImports: 5,
      circularDependencies: 1,
      oversizedFiles: 2,
      oversizedModules: 3,
      publicEntrypointCount: 3,
    });
    expect(
      first.repository.imports.find((edge) => edge.toFile === "node:crypto")
        ?.kind,
    ).toBe("external");
    expect(second.repository).toEqual(first.repository);
    expect(second.metrics).toEqual(first.metrics);

    const snapshot = createArchitectureSnapshot({
      projectRoot,
      gitCommit: null,
      configHash: configHash(config),
      repository: first.repository,
      metrics: first.metrics,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const savedPath = await new JsonSnapshotStore(projectRoot).save(snapshot);
    expect(
      architectureSnapshotSchema.parse(
        JSON.parse(await readFile(savedPath, "utf8")),
      ),
    ).toBeTruthy();
  });
});
