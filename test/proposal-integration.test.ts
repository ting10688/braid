import path from "node:path";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { analyzeRepository } from "@braid/analyzer";
import {
  configHash,
  migrationConfigHash,
  createArchitectureSnapshot,
  loadArchitectureConfig,
  migrationProposalSchema,
} from "@braid/core";
import { generateMigrationProposals } from "@braid/planner";
import { CONFIG_FILE } from "@braid/shared";
import { JsonProposalStore } from "@braid/store";
import { proposeCommand } from "../apps/cli/src/commands/propose.js";
import { sourceHash } from "./source-hash.js";

const sourceFixture = fileURLToPath(
  new URL("../examples/bloated-saas", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Phase 2 proposal integration", () => {
  it("generates both stable proposal types and never mutates source files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "braid-proposals-"));
    temporaryDirectories.push(parent);
    const projectRoot = path.join(parent, "bloated-saas");
    await cp(sourceFixture, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes("/dist") &&
        !source.includes("/node_modules") &&
        !source.includes("/.braid/state"),
    });
    const before = await sourceHash(projectRoot);
    const config = await loadArchitectureConfig(
      path.join(projectRoot, CONFIG_FILE),
    );
    const analysis = await analyzeRepository(projectRoot, config);
    const snapshot = createArchitectureSnapshot({
      projectRoot,
      gitCommit: null,
      configHash: configHash(config),
      migrationConfigHash: migrationConfigHash(config),
      repository: analysis.repository,
      metrics: analysis.metrics,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const first = generateMigrationProposals(snapshot, config);
    const second = generateMigrationProposals(
      {
        ...snapshot,
        repository: {
          ...snapshot.repository,
          files: [...snapshot.repository.files].reverse(),
          imports: [...snapshot.repository.imports].reverse(),
          cycles: [...snapshot.repository.cycles].reverse(),
        },
      },
      config,
    );
    expect(first).toHaveLength(2);
    expect(first.map((proposal) => proposal.type)).toEqual([
      "break-cycle",
      "extract-module",
    ]);
    expect(second.map((proposal) => proposal.id)).toEqual(
      first.map((proposal) => proposal.id),
    );
    const cycle = first.find((proposal) => proposal.type === "break-cycle")!;
    expect(cycle.target).toMatchObject({
      type: "break-cycle",
      cycleModules: ["orders", "users"],
      selectedEdge: { fromModule: "orders", toModule: "users" },
    });
    expect(cycle.expectedImpact.simulated[0]?.delta).toBe(-1);
    const extraction = first.find(
      (proposal) => proposal.type === "extract-module",
    )!;
    expect(extraction.target).toMatchObject({
      type: "extract-module",
      candidateSymbols: ["notificationLog", "sentNotifications"],
      suggestedModuleName: "notification",
    });

    const store = new JsonProposalStore(projectRoot);
    for (const proposal of first) {
      const destination = await store.save(proposal);
      expect(
        migrationProposalSchema.parse(
          JSON.parse(await readFile(destination, "utf8")),
        ),
      ).toBeTruthy();
      await expect(store.save(proposal)).resolves.toBe(destination);
    }
    expect(
      await readdir(path.join(projectRoot, ".braid", "state", "proposals")),
    ).toHaveLength(2);

    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    await proposeCommand(projectRoot, { save: true });
    expect(stdout.join("")).toContain("Braid migration proposals");
    expect(await sourceHash(projectRoot)).toBe(before);
  });
});
