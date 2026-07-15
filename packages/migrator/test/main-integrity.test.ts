import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMainCheckoutIntegrity,
  captureMainCheckoutState,
} from "../src/main-integrity.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-main-integrity-"));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, ".gitignore"), ".braid/executions/\n");
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Braid Test",
    "-c",
    "user.email=braid@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return root;
};

describe("main checkout integrity", () => {
  it("accepts an unchanged main checkout and ignored execution artifacts", async () => {
    const root = await repository();
    const before = await captureMainCheckoutState(root);
    await mkdir(path.join(root, ".braid", "executions"), { recursive: true });
    await writeFile(
      path.join(root, ".braid", "executions", "record.json"),
      "{}",
    );
    const after = await captureMainCheckoutState(root);
    expect(() => assertMainCheckoutIntegrity(before, after)).not.toThrow();
  });

  it("detects tracked source and index mutation", async () => {
    const root = await repository();
    const before = await captureMainCheckoutState(root);
    await writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
    await execFileAsync("git", ["-C", root, "add", "source.ts"]);
    const after = await captureMainCheckoutState(root);
    expect(() => assertMainCheckoutIntegrity(before, after)).toThrowError(
      expect.objectContaining({ exitCode: 11, code: "main-checkout-mutated" }),
    );
  });

  it("detects shared repository configuration and protected-ref mutation", async () => {
    const configRoot = await repository();
    const configBefore = await captureMainCheckoutState(configRoot);
    await execFileAsync("git", [
      "-C",
      configRoot,
      "config",
      "remote.origin.url",
      "https://example.invalid/repository.git",
    ]);
    const configAfter = await captureMainCheckoutState(configRoot);
    expect(() =>
      assertMainCheckoutIntegrity(configBefore, configAfter),
    ).toThrowError(
      expect.objectContaining({ exitCode: 11, code: "main-checkout-mutated" }),
    );

    const refRoot = await repository();
    const refBefore = await captureMainCheckoutState(refRoot);
    await execFileAsync("git", ["-C", refRoot, "tag", "unexpected-tag"]);
    const refAfter = await captureMainCheckoutState(refRoot);
    expect(() => assertMainCheckoutIntegrity(refBefore, refAfter)).toThrowError(
      expect.objectContaining({ exitCode: 11, code: "main-checkout-mutated" }),
    );
  });

  it("excludes only the exact owned candidate ref", async () => {
    const root = await repository();
    const options = {
      ownedCandidateRef: "refs/heads/braid/exec/12345678",
    } as const;
    const before = await captureMainCheckoutState(root, options);
    await execFileAsync("git", ["-C", root, "branch", "braid/exec/12345678"]);
    const ownedAfter = await captureMainCheckoutState(root, options);
    expect(() => assertMainCheckoutIntegrity(before, ownedAfter)).not.toThrow();

    await execFileAsync("git", ["-C", root, "branch", "braid/exec/deadbeef"]);
    const unrelatedAfter = await captureMainCheckoutState(root, options);
    expect(() =>
      assertMainCheckoutIntegrity(before, unrelatedAfter),
    ).toThrowError(
      expect.objectContaining({ exitCode: 11, code: "main-checkout-mutated" }),
    );
  });

  it("detects ignored-file, hook, lock, pseudoref, and worktree-registry mutation", async () => {
    const root = await repository();
    const before = await captureMainCheckoutState(root);
    await writeFile(path.join(root, ".git", "info", "exclude"), "hidden.tmp\n");
    await writeFile(path.join(root, "hidden.tmp"), "hidden main mutation\n");
    await writeFile(
      path.join(root, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
    );
    await writeFile(
      path.join(root, ".git", "ORIG_HEAD"),
      `${"f".repeat(40)}\n`,
    );
    await mkdir(path.join(root, ".git", "refs", "heads"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".git", "refs", "heads", "main.lock"),
      "blocked\n",
    );
    await mkdir(path.join(root, ".git", "objects", "pack"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".git", "objects", "pack", "pending.lock"),
      "blocked\n",
    );
    await mkdir(path.join(root, ".git", "worktrees", "foreign"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".git", "worktrees", "foreign", "HEAD"),
      "ref: refs/heads/foreign\n",
    );

    const after = await captureMainCheckoutState(root);
    expect(after.clean).toBe(true);
    expect(() => assertMainCheckoutIntegrity(before, after)).toThrowError(
      expect.objectContaining({ exitCode: 11, code: "main-checkout-mutated" }),
    );
  });

  it("rejects an unreadable checkout when a shared index lock remains", async () => {
    const root = await repository();
    await writeFile(path.join(root, ".git", "index.lock"), "blocked\n");

    await expect(captureMainCheckoutState(root)).rejects.toMatchObject({
      exitCode: 11,
      code: "main-checkout-unreadable",
    });
  });
});
