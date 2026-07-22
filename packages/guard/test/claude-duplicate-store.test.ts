import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDuplicateStore } from "../src/claude/duplicate-store.js";

const roots: string[] = [];

const store = async (
  session = "private-session-id",
  worktree = "WT-safe",
): Promise<ClaudeDuplicateStore> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-claude-duplicate-"));
  roots.push(root);
  return new ClaudeDuplicateStore(root, session, worktree);
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Claude native/manual duplicate coordination", () => {
  it("defers manual SessionStart and makes native authoritative in either arrival order", async () => {
    const manualFirst = await store();
    expect(await manualFirst.preflight("manual", "SessionStart")).toEqual({
      action: "defer",
    });
    expect(
      await manualFirst.preflight("native-plugin", "SessionStart"),
    ).toEqual({ action: "evaluate" });
    expect(await manualFirst.preflight("manual", "UserPromptSubmit")).toEqual({
      action: "duplicate",
    });

    const nativeFirst = await store("another-session");
    expect(
      await nativeFirst.preflight("native-plugin", "SessionStart"),
    ).toEqual({ action: "evaluate" });
    expect(await nativeFirst.preflight("manual", "SessionStart")).toEqual({
      action: "duplicate",
    });
  });

  it("lets a manual-only adapter initialize lazily on the prompt", async () => {
    const manual = await store();
    expect(await manual.preflight("manual", "SessionStart")).toEqual({
      action: "defer",
    });
    expect(await manual.preflight("manual", "UserPromptSubmit")).toEqual({
      action: "evaluate",
    });
  });

  it("claims one evaluation per event and relevant fingerprint", async () => {
    const native = await store();
    await native.preflight("native-plugin", "SessionStart");
    expect(await native.claim("native-plugin", "Stop", "DIFF-a")).toBe(true);
    expect(await native.claim("native-plugin", "Stop", "DIFF-a")).toBe(false);
    expect(await native.claim("native-plugin", "Stop", "DIFF-b")).toBe(true);
    expect(await native.claim("native-plugin", "PostToolUse", "DIFF-a")).toBe(
      true,
    );
  });

  it("isolates sessions and worktrees without persisting the raw session ID", async () => {
    const first = await store("secret-session", "WT-one");
    const second = new ClaudeDuplicateStore(
      first.gitDirectory,
      "secret-session",
      "WT-two",
    );
    expect(await first.claim("manual", "Stop", "DIFF-a")).toBe(true);
    expect(await second.claim("manual", "Stop", "DIFF-a")).toBe(true);

    const persisted = await readFile(first.claimPath("Stop", "DIFF-a"), "utf8");
    expect(persisted).not.toContain("secret-session");
    expect(persisted).not.toContain("DIFF-a");
    expect(persisted).toContain("WT-one");
  });

  it("uses atomic claims under concurrency", async () => {
    const native = await store();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        native.claim("native-plugin", "PostToolUse", "DIFF-concurrent"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
