import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrationProposalSchema, type MigrationProposal } from "@braid/core";
import { JsonProposalStore, serializeProposal } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const proposal = (id = "P-EM-a18d42f3"): MigrationProposal =>
  migrationProposalSchema.parse({
    schemaVersion: 1,
    id,
    snapshotId: "S-example",
    type: "extract-module",
    title: "Extract notification responsibilities",
    summary: "A deterministic extraction candidate.",
    affectedFiles: ["src/orders/order-service.ts"],
    affectedModules: ["orders"],
    target: {
      type: "extract-module",
      sourceFile: "src/orders/order-service.ts",
      sourceModule: "orders",
      candidateSymbols: ["sendNotification", "buildNotification"],
      suggestedModuleName: "notification",
    },
    evidence: [
      {
        type: "oversized-file",
        file: "src/orders/order-service.ts",
        actualLines: 600,
        thresholdLines: 500,
      },
    ],
    expectedImpact: {
      simulated: [],
      estimated: [
        {
          metric: "oversizedFiles",
          direction: "unknown",
          rationale: "Caller rewrites are not simulated.",
        },
      ],
      unknowns: ["Exact imports are unknown."],
    },
    risk: { level: "low", points: 0, factors: [] },
    reversibility: { level: "easy", factors: ["Bounded change."] },
    preconditions: ["Tests pass."],
    constraints: ["Preserve behavior."],
    rollbackStrategy: "Restore declarations and imports.",
    ranking: {
      severity: 2,
      confidence: 3,
      expectedBenefit: 1,
      riskPenalty: 0,
      deterministicTieBreaker: id,
    },
  });

describe("JSON proposal store", () => {
  it("atomically saves, validates, loads, and idempotently preserves content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-proposals-"));
    temporaryDirectories.push(root);
    const store = new JsonProposalStore(root);
    const item = proposal();
    const destination = await store.save(item);
    expect(await store.load(item.id)).toEqual(
      migrationProposalSchema.parse(
        JSON.parse(await readFile(destination, "utf8")),
      ),
    );
    await expect(store.save(item)).resolves.toBe(destination);
    await expect(
      store.save({ ...item, snapshotId: "S-new-snapshot" }),
    ).resolves.toBe(destination);
    expect(await readdir(path.dirname(destination))).toEqual([
      `${item.id}.json`,
    ]);
  });

  it("rejects conflicting same-ID content without partial files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-proposals-"));
    temporaryDirectories.push(root);
    const store = new JsonProposalStore(root);
    const item = proposal();
    const destination = await store.save(item);
    await expect(
      store.save({ ...item, title: "Conflicting proposal" }),
    ).rejects.toThrow(/different content/u);
    expect(
      (await readdir(path.dirname(destination))).filter((file) =>
        file.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("preserves prior proposals and stable-sorts unordered fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-proposals-"));
    temporaryDirectories.push(root);
    const store = new JsonProposalStore(root);
    const first = proposal();
    const second = proposal("P-EM-b18d42f3");
    await store.save(first);
    await store.save(second);
    expect(
      await readdir(path.join(root, ".braid", "state", "proposals")),
    ).toEqual([`${first.id}.json`, `${second.id}.json`]);
    expect(
      serializeProposal({
        ...first,
        affectedFiles: [...first.affectedFiles].reverse(),
        target: {
          ...first.target,
          candidateSymbols: [...first.target.candidateSymbols].reverse(),
        },
      }),
    ).toBe(serializeProposal(first));
  });

  it("rejects malformed persisted proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-proposals-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, ".braid", "state", "proposals");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "P-EM-a18d42f3.json"),
      '{"schemaVersion":1}',
    );
    await expect(
      new JsonProposalStore(root).load("P-EM-a18d42f3"),
    ).rejects.toThrow(/Could not load proposal/u);
  });
});
