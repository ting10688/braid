import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { architectureConfigSchema } from "@braid/core";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { createFixtureManifest } from "../src/fixtures/fixture-manifest.js";
import { loadProtocol, loadSuite } from "../src/fixtures/fixture-loader.js";
import {
  loadRepositoryManifest,
  repositoryMetadataPath,
} from "../src/repositories/repository-materializer.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const benchmarksRoot = path.join(workspaceRoot, "benchmarks");

describe("real-world repository metadata", () => {
  it("loads both qualification outcomes and repository-specific Braid configs", async () => {
    const consola = await loadRepositoryManifest(benchmarksRoot, "consola");
    const tslog = await loadRepositoryManifest(benchmarksRoot, "tslog");
    expect(consola.qualification.status).toBe("qualified");
    expect(tslog.qualification.status).toBe("qualified-with-limitations");
    for (const manifest of [consola, tslog]) {
      const config = architectureConfigSchema.parse(
        parse(
          await readFile(
            path.join(
              repositoryMetadataPath(benchmarksRoot, manifest.id),
              manifest.braidConfiguration.file,
            ),
            "utf8",
          ),
        ),
      );
      expect(config.source.include).toEqual(manifest.source.include);
      expect(config.source.exclude).toContain("**/*.d.ts");
      expect(config.thresholds).toEqual({
        oversized_file_lines: 500,
        oversized_module_files: 20,
        oversized_module_exports: 25,
        max_module_dependencies: 8,
      });
      expect(config.protected_paths.length).toBeGreaterThan(0);
    }
  });

  it("freezes all repository compatibility hashes without private paths", async () => {
    const suite = await loadSuite(benchmarksRoot, "real-world-phase-2");
    const fixture = await createFixtureManifest(
      benchmarksRoot,
      suite,
      await loadProtocol(benchmarksRoot),
    );
    expect(fixture.repositories).toHaveLength(2);
    expect(fixture.repositories[0]).toMatchObject({
      id: "consola",
      commit: "c47faac1738b7383971c6c20b5a34ffa15e7cc3b",
      qualificationStatus: "qualified",
    });
    expect(JSON.stringify(fixture)).not.toContain(workspaceRoot);
    expect(JSON.stringify(fixture)).not.toMatch(
      /\/Users\/|\/private\/tmp\/|\/tmp\//u,
    );
  });
});
