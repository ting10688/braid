import path from "node:path";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proposeCommand } from "../apps/cli/src/commands/propose.js";

const sourceFixture = fileURLToPath(
  new URL("../examples/bloated-saas", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const stateFiles = async (projectRoot: string): Promise<string[]> => {
  const state = path.join(projectRoot, ".braid", "state");
  const files: string[] = [];
  for (const directory of ["snapshots", "proposals"]) {
    try {
      for (const file of await readdir(path.join(state, directory)))
        files.push(`${directory}/${file}`);
    } catch {
      // An absent directory is valid before the first saved proposal run.
    }
  }
  return files.sort();
};

describe("braid propose CLI", () => {
  it("supports saving, JSON, no-save, limits, type filters, and snapshots", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "braid-cli-propose-"));
    temporaryDirectories.push(parent);
    const projectRoot = path.join(parent, "bloated-saas");
    await cp(sourceFixture, projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes("/dist") &&
        !source.includes("/node_modules") &&
        !source.includes("/.braid/state"),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    await proposeCommand(projectRoot, { save: true });
    expect(stdout.join("")).toContain("Proposals: 2");
    const snapshots = await readdir(
      path.join(projectRoot, ".braid", "state", "snapshots"),
    );
    const snapshotId = snapshots[0]!.replace(/\.json$/u, "");
    expect(
      await readdir(path.join(projectRoot, ".braid", "state", "proposals")),
    ).toHaveLength(2);

    stdout.length = 0;
    await proposeCommand(projectRoot, { json: true, save: false });
    const json = JSON.parse(stdout.join(""));
    expect(json.proposals).toHaveLength(2);
    expect(stderr).toEqual([]);

    stdout.length = 0;
    await proposeCommand(projectRoot, { save: false, limit: "1" });
    expect(stdout.join("")).toContain("Proposals: 1");

    for (const type of ["extract-module", "break-cycle"] as const) {
      stdout.length = 0;
      await proposeCommand(projectRoot, { json: true, save: false, type });
      expect(
        JSON.parse(stdout.join("")).proposals.every(
          (proposal: { type: string }) => proposal.type === type,
        ),
      ).toBe(true);
    }

    stdout.length = 0;
    await proposeCommand(projectRoot, {
      json: true,
      save: false,
      snapshot: snapshotId,
    });
    expect(JSON.parse(stdout.join("")).snapshotId).toBe(snapshotId);

    const beforeNoSave = await stateFiles(projectRoot);
    await proposeCommand(projectRoot, { save: false });
    expect(await stateFiles(projectRoot)).toEqual(beforeNoSave);
    expect(
      JSON.parse(
        await readFile(
          path.join(
            projectRoot,
            ".braid",
            "state",
            "proposals",
            (
              await readdir(
                path.join(projectRoot, ".braid", "state", "proposals"),
              )
            )[0]!,
          ),
          "utf8",
        ),
      ).schemaVersion,
    ).toBe(1);
  });
});
