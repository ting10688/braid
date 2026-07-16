import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ARCHITECTURE_CONFIG } from "@braid/core";
import {
  growthCheckCommand,
  growthContextCommand,
  growthFinalCommand,
  growthResetCommand,
} from "../src/commands/growth.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const git = async (root: string, ...arguments_: string[]): Promise<string> =>
  (
    await execFileAsync("git", ["-C", root, ...arguments_], {
      encoding: "utf8",
    })
  ).stdout.trim();

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-growth-cli-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".braid"), { recursive: true });
  await mkdir(path.join(root, "src", "modules", "orders"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ".braid", "architecture.yaml"),
    DEFAULT_ARCHITECTURE_CONFIG.replace(
      "growthMode:\n  enabled: false",
      "growthMode:\n  enabled: true",
    ),
  );
  await writeFile(
    path.join(root, "src", "modules", "orders", "service.ts"),
    "export const order = 1;\n",
  );
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "growth@example.test");
  await git(root, "config", "user.name", "Growth Test");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture");
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Growth Mode CLI commands", () => {
  it("runs one baseline, safe check, final, and confirmed reset without source or Git mutation", async () => {
    const root = await fixture();
    const sourcePath = path.join(
      root,
      "src",
      "modules",
      "orders",
      "service.ts",
    );
    const sourceBefore = sha256(await readFile(sourcePath, "utf8"));
    const headBefore = await git(root, "rev-parse", "HEAD");
    const indexBefore = await git(root, "ls-files", "--stage");
    const worktreesBefore = await git(root, "worktree", "list", "--porcelain");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await growthContextCommand({
      path: root,
      session: "cli-session",
      json: true,
    });
    const context = JSON.parse(output.join("")) as {
      initialized: boolean;
      report: { status: string };
    };
    expect(context).toMatchObject({
      initialized: true,
      report: { status: "pass" },
    });

    const expectedSource = "export const order = 2;\n";
    await writeFile(sourcePath, expectedSource);
    output.length = 0;
    await growthCheckCommand({
      path: root,
      session: "cli-session",
      json: true,
    });
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "pass" });

    output.length = 0;
    await growthFinalCommand({
      path: root,
      session: "cli-session",
      json: true,
    });
    expect(JSON.parse(output.join(""))).toMatchObject({
      report: { status: "pass" },
      shouldBlock: false,
    });

    await expect(
      growthResetCommand({
        path: root,
        session: "cli-session",
        confirm: "wrong-session",
      }),
    ).rejects.toThrow(/--confirm cli-session/u);
    output.length = 0;
    await growthResetCommand({
      path: root,
      session: "cli-session",
      confirm: "cli-session",
      json: true,
    });
    expect(JSON.parse(output.join(""))).toEqual({
      sessionId: "cli-session",
      removed: true,
    });

    expect(sha256(await readFile(sourcePath, "utf8"))).not.toBe(sourceBefore);
    expect(await readFile(sourcePath, "utf8")).toBe(expectedSource);
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "ls-files", "--stage")).toBe(indexBefore);
    expect(await git(root, "worktree", "list", "--porcelain")).toBe(
      worktreesBefore,
    );
    expect(await git(root, "status", "--porcelain=v1")).toBe(
      "M src/modules/orders/service.ts",
    );
  });
});
