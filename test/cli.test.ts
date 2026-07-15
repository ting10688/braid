import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeCommand } from "../apps/cli/src/commands/analyze.js";
import { initCommand } from "../apps/cli/src/commands/init.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Braid CLI", () => {
  it("initializes .braid and keeps JSON output machine-readable without saving", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "braid-cli-"));
    temporaryDirectories.push(root);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    await initCommand(root, {});
    await expect(
      stat(path.join(root, ".braid", "architecture.yaml")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(root, ".braid", "state", "project.json")),
    ).resolves.toBeTruthy();
    await expect(
      stat(path.join(root, ".braid", "state", "snapshots")),
    ).resolves.toBeTruthy();
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".")),
    ).toEqual([".braid"]);
    const projectState = JSON.parse(
      await readFile(
        path.join(root, ".braid", "state", "project.json"),
        "utf8",
      ),
    );
    expect(projectState.configFile).toBe(".braid/architecture.yaml");

    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src", "index.ts"),
      "export const ready = true;\n",
    );
    stdout.length = 0;
    await analyzeCommand(root, { save: true });
    expect(stdout.join("")).toContain("Braid analysis");
    expect(stdout.join("")).toContain(".braid/state/snapshots/");
    const snapshots = path.join(root, ".braid", "state", "snapshots");
    expect(await readdir(snapshots)).toHaveLength(1);

    stdout.length = 0;
    await analyzeCommand(root, { json: true, save: false });
    expect(JSON.parse(stdout.join("")).schemaVersion).toBe(1);
    expect(await readdir(snapshots)).toHaveLength(1);
  });
});
