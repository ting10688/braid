import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyFixture,
  initializeFixtureGit,
} from "../src/fixtures/fixture-copier.js";
import { benchmarkAssetPath } from "../src/fixtures/fixture-loader.js";
import { loadProtocol, loadSuite } from "../src/fixtures/fixture-loader.js";
import { createFixtureManifest } from "../src/fixtures/fixture-manifest.js";
import { hashSourceTree } from "../src/fixtures/source-hasher.js";
import { runCommand } from "../src/runner/command-runner.js";

const template = fileURLToPath(
  new URL(
    "../../../benchmarks/fixtures/templates/clean-modular-app",
    import.meta.url,
  ),
);
const benchmarksRoot = fileURLToPath(
  new URL("../../../benchmarks", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fixture isolation", () => {
  it("rejects benchmark assets outside the benchmark root", () => {
    expect(() =>
      benchmarkAssetPath(path.dirname(template), "../../escape"),
    ).toThrow(/escapes the benchmark root/u);
  });

  it("copies without mutating the template and hashes deterministically", async () => {
    const templateBefore = await hashSourceTree(template);
    const copy = await copyFixture(template);
    temporaryDirectories.push(copy);
    expect((await hashSourceTree(copy)).digest).toBe(templateBefore.digest);
    await writeFile(
      path.join(copy, "src", "index.ts"),
      "export const changed = true;\n",
    );
    expect((await hashSourceTree(copy)).digest).not.toBe(templateBefore.digest);
    expect((await hashSourceTree(template)).digest).toBe(templateBefore.digest);
  });

  it("ignores generated state and creates a deterministic local Git baseline", async () => {
    const copy = await copyFixture(template);
    temporaryDirectories.push(copy);
    const before = await hashSourceTree(copy);
    await mkdir(path.join(copy, "dist"), { recursive: true });
    await mkdir(path.join(copy, ".braid", "state", "snapshots"), {
      recursive: true,
    });
    await writeFile(path.join(copy, "dist", "index.js"), "generated\n");
    await writeFile(
      path.join(copy, ".braid", "state", "snapshots", "one.json"),
      "{}\n",
    );
    expect((await hashSourceTree(copy)).digest).toBe(before.digest);
    await initializeFixtureGit(copy, 10_000);
    expect(
      (
        await runCommand(["git", "log", "-1", "--format=%s"], {
          cwd: copy,
          timeoutMs: 10_000,
        })
      ).stdout.trim(),
    ).toBe("benchmark baseline");
  });

  it("creates deterministic relative fixture hashes and changes on content", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "braid-fixture-manifest-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const fixture = path.join(
      temporaryRoot,
      "fixtures",
      "templates",
      "clean-modular-app",
    );
    await mkdir(path.dirname(fixture), { recursive: true });
    await cp(template, fixture, { recursive: true });
    await mkdir(path.join(temporaryRoot, "expectations"), { recursive: true });
    await cp(
      path.join(benchmarksRoot, "expectations", "clean-modular-app.json"),
      path.join(temporaryRoot, "expectations", "clean-modular-app.json"),
    );
    const suite = await loadSuite(benchmarksRoot, "phase-2-core");
    const selected = { ...suite, cases: [suite.cases[0]!] };
    const protocol = await loadProtocol(benchmarksRoot);
    const first = await createFixtureManifest(
      temporaryRoot,
      selected,
      protocol,
    );
    const repeat = await createFixtureManifest(
      temporaryRoot,
      selected,
      protocol,
    );
    expect(repeat).toEqual(first);
    expect(JSON.stringify(first.manifest)).not.toContain(temporaryRoot);
    await writeFile(path.join(fixture, "src", "index.ts"), "changed\n");
    const changed = await createFixtureManifest(
      temporaryRoot,
      selected,
      protocol,
    );
    expect(changed.manifest.hash).not.toBe(first.manifest.hash);
  });
});
