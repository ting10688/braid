import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE_CONFIG,
  parseArchitectureConfig,
} from "@braid/core";
import { canonicalJson } from "../src/canonical.js";
import { compareGrowth } from "../src/comparison.js";
import { formatGrowthModeReport } from "../src/formatter.js";
import { createGrowthGuard } from "../src/growth-guard.js";
import { resolveGitContext } from "../src/git-state.js";
import { GrowthStateStore } from "../src/state-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const fixedNow = () => new Date("2026-07-16T00:00:00.000Z");

const git = async (root: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
};

const enabledConfig = (source = DEFAULT_ARCHITECTURE_CONFIG): string =>
  source.replace(
    "growthMode:\n  enabled: false",
    "growthMode:\n  enabled: true",
  );

interface FixtureOptions {
  cycle?: boolean;
  warning?: boolean;
  config?: (value: string) => string;
  featureFiles?: number;
}

const fixture = async (options: FixtureOptions = {}): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "braid-growth-guard-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, ".braid"), { recursive: true }),
    mkdir(path.join(root, "src", "a"), { recursive: true }),
    mkdir(path.join(root, "src", "b"), { recursive: true }),
    mkdir(path.join(root, "src", "feature"), { recursive: true }),
  ]);
  const config = options.config?.(enabledConfig()) ?? enabledConfig();
  await Promise.all([
    writeFile(path.join(root, ".braid", "architecture.yaml"), config),
    writeFile(path.join(root, "package.json"), '{"name":"growth-fixture"}\n'),
    writeFile(
      path.join(root, "src", "a", "index.ts"),
      options.warning
        ? "export const = ;\n"
        : options.cycle
          ? 'import { b } from "../b/index.js";\nexport const a = b;\n'
          : "export const a = 1;\n",
    ),
    writeFile(
      path.join(root, "src", "b", "index.ts"),
      'import { a } from "../a/index.js";\nexport const b = a;\n',
    ),
    ...Array.from({ length: options.featureFiles ?? 0 }, (_, index) =>
      writeFile(
        path.join(root, "src", "feature", `${index + 1}.ts`),
        `export const feature${index + 1} = ${index + 1};\n`,
      ),
    ),
  ]);
  await execFileAsync("git", ["init", "--quiet", root]);
  await git(root, "config", "user.email", "growth@example.test");
  await git(root, "config", "user.name", "Growth Fixture");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
};

const guard = (root: string, sessionId: string) =>
  createGrowthGuard({ projectRoot: root, sessionId, now: fixedNow });

const introduceCycle = async (root: string): Promise<void> =>
  writeFile(
    path.join(root, "src", "a", "index.ts"),
    'import { b } from "../b/index.js";\nexport const a = b;\n',
  );

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Growth Mode guard", () => {
  it("uses locale-independent canonical key ordering", () => {
    expect(canonicalJson({ "ä.ts": "a", "z.ts": "z" })).toBe(
      '{"z.ts":"z","ä.ts":"a"}',
    );
  });

  it("canonicalizes cycle rotations without merging a different route", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "cycle-order-session");
    await lifecycle.context();
    const context = await resolveGitContext(root);
    const state = await new GrowthStateStore(
      context.gitDirectory,
      "cycle-order-session",
      context.repository,
    ).load();
    if (!state) throw new Error("Expected the baseline state to exist");
    const config = parseArchitectureConfig(
      await readFile(path.join(root, ".braid", "architecture.yaml"), "utf8"),
    );
    const compareCycle = (files: string[]) =>
      compareGrowth({
        baseline: state.baseline,
        current: {
          repository: {
            ...state.baseline.repository,
            projectRoot: root,
            cycles: [{ modules: ["a", "b", "c"], files }],
          },
          warnings: [],
        },
        config,
        changedPaths: [],
      });

    const canonical = compareCycle(["a.ts", "b.ts", "c.ts"]);
    const rotated = compareCycle(["b.ts", "c.ts", "a.ts"]);
    const differentRoute = compareCycle(["a.ts", "c.ts", "b.ts"]);
    expect(rotated.findings).toEqual(canonical.findings);
    expect(differentRoute.findings[0]?.id).not.toBe(canonical.findings[0]?.id);
  });

  it("captures a deterministic baseline once per session", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "baseline-session");
    const first = await lifecycle.context();
    const second = await lifecycle.context();

    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(false);
    expect(second.report.baseline).toEqual(first.report.baseline);
    expect(second.report.baseline.id).toMatch(/^GB-[a-f0-9]{12}$/u);

    await writeFile(
      path.join(root, "src", "a", "index.ts"),
      "export const a = 2;\n",
    );
    const laterSession = await guard(root, "later-session").context();
    expect(laterSession.report.baseline.id).not.toBe(first.report.baseline.id);
  });

  it("skips unchanged input without repeating feedback", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "no-change-session");
    const context = await lifecycle.context();

    const first = await lifecycle.check();
    const second = await lifecycle.check();
    expect(first.report.skippedReason).toBe("no-relevant-change");
    expect(first.report.statistics.noChangeSkip).toBe(true);
    expect(first.report.id).not.toBe(context.report.id);
    expect(first.feedback).toBeNull();
    expect(second.report).toEqual(first.report);
  });

  it("invalidates the cache when a relevant staged diff changes", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "staged-diff-session");
    await lifecycle.context();

    await introduceCycle(root);
    await git(root, "add", "src/a/index.ts");
    await writeFile(
      path.join(root, "src", "a", "index.ts"),
      "export const a = 1;\n",
    );

    const changed = await lifecycle.check();
    expect(changed.report.cacheHit).toBe(false);
    expect(changed.report.skippedReason).toBeNull();
    expect(changed.report.changedPaths).toEqual([]);
    expect(changed.report.status).toBe("pass");
    expect((await lifecycle.check()).report.cacheHit).toBe(true);
  });

  it("states clearly when Growth Mode is disabled", async () => {
    const root = await fixture({
      config: () => DEFAULT_ARCHITECTURE_CONFIG,
    });
    const result = await guard(root, "disabled-session").context();

    expect(result.report.skippedReason).toBe("growth-mode-disabled");
    expect(result.text).toContain("Growth Mode is disabled");
    expect(result.text).not.toContain("is active");
    expect(formatGrowthModeReport(result.report)).toContain("DISABLED");
  });

  it("accepts a safe change and reports affected importers", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "safe-session");
    await lifecycle.context();
    await writeFile(
      path.join(root, "src", "a", "index.ts"),
      "export const a = 2;\n",
    );

    const result = await lifecycle.check();
    expect(result.report.status).toBe("pass");
    expect(result.report.changedPaths).toEqual(["src/a/index.ts"]);
    expect(result.report.affectedPaths).toEqual([
      "src/a/index.ts",
      "src/b/index.ts",
    ]);
    expect(result.feedback).toBeNull();
  });

  it("blocks a new cycle but never blocks an unchanged pre-existing cycle", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "new-cycle-session");
    await lifecycle.context();
    await introduceCycle(root);

    const introduced = await lifecycle.check();
    expect(introduced.report.status).toBe("block");
    expect(introduced.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "new-cycle", severity: "block" }),
      ]),
    );
    expect(introduced.feedback).toContain("New dependency cycle");
    const truncated = formatGrowthModeReport(introduced.report, 80);
    expect(truncated.length).toBeLessThanOrEqual(80);
    expect(truncated).toMatch(/…$/u);

    const preexistingRoot = await fixture({ cycle: true });
    const preexisting = guard(preexistingRoot, "preexisting-cycle-session");
    const baseline = await preexisting.context();
    expect(baseline.report.status).toBe("pass");
    await writeFile(
      path.join(preexistingRoot, "src", "feature", "safe.ts"),
      "export const safe = true;\n",
    );
    expect((await preexisting.check()).report.status).toBe("pass");
  });

  it("describes pre-existing architecture risk in session context", async () => {
    const root = await fixture({ cycle: true });
    const result = await guard(root, "context-risk-session").context();

    expect(result.report.status).toBe("pass");
    expect(result.text).toContain(
      "Pre-existing baseline: 1 dependency cycle, 0 oversized modules, and 0 analyzer warnings.",
    );
    expect(result.text).toContain(
      "pre-existing issues do not block completion",
    );
  });

  it("does not warn again for unchanged baseline analyzer evidence", async () => {
    const root = await fixture({ warning: true });
    const lifecycle = guard(root, "baseline-warning-session");
    await lifecycle.context();
    await writeFile(
      path.join(root, "src", "feature", "safe.ts"),
      "export const safe = true;\n",
    );

    const result = await lifecycle.check();
    expect(result.report.status).toBe("pass");
    expect(result.report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "analysis-incomplete" }),
      ]),
    );
  });

  it("scrubs all absolute paths from analyzer warning evidence", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "warning-privacy-session");
    await lifecycle.context();
    const context = await resolveGitContext(root);
    const state = await new GrowthStateStore(
      context.gitDirectory,
      "warning-privacy-session",
      context.repository,
    ).load();
    if (!state) throw new Error("Expected the baseline state to exist");

    const comparison = compareGrowth({
      baseline: state.baseline,
      current: {
        repository: { ...state.baseline.repository, projectRoot: root },
        warnings: [
          "Parser failed at /Users/private/project/src/a.ts",
          "Resolver failed at C:\\Users\\private\\project\\src\\b.ts",
        ],
      },
      config: parseArchitectureConfig(
        await readFile(path.join(root, ".braid", "architecture.yaml"), "utf8"),
      ),
      changedPaths: [],
    });
    const evidence = JSON.stringify(comparison.findings);
    expect(evidence).not.toContain("/Users/private");
    expect(evidence).not.toContain("C:\\\\Users");
    expect(evidence).toContain("<absolute-path>");
  });

  it("reports repaired baseline issues as improvements", async () => {
    const root = await fixture({ cycle: true });
    const lifecycle = guard(root, "repair-session");
    await lifecycle.context();
    await writeFile(
      path.join(root, "src", "b", "index.ts"),
      "export const b = 1;\n",
    );

    const result = await lifecycle.check();
    expect(result.report.status).toBe("pass");
    expect(result.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "pre-existing-issue-removed",
          severity: "info",
        }),
      ]),
    );
  });

  it("warns when a module crosses or grows beyond its size threshold", async () => {
    const config = (value: string) =>
      value.replace("oversized_module_files: 20", "oversized_module_files: 1");
    const crossedRoot = await fixture({ config, featureFiles: 1 });
    const crossed = guard(crossedRoot, "crossed-session");
    await crossed.context();
    await writeFile(
      path.join(crossedRoot, "src", "feature", "2.ts"),
      "export const feature2 = 2;\n",
    );
    expect((await crossed.check()).report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "oversized-threshold-crossed" }),
      ]),
    );

    const growthRoot = await fixture({ config, featureFiles: 2 });
    const growth = guard(growthRoot, "growth-session");
    await growth.context();
    await writeFile(
      path.join(growthRoot, "src", "feature", "3.ts"),
      "export const feature3 = 3;\n",
    );
    expect((await growth.check()).report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "oversized-module-growth" }),
      ]),
    );
  });

  it("invalidates the cache for configuration changes", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "config-session");
    await lifecycle.context();
    const configPath = path.join(root, ".braid", "architecture.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "maxFindings: 5",
        "maxFindings: 6",
      ),
    );

    const changed = await lifecycle.check();
    expect(changed.report.cacheHit).toBe(false);
    expect(changed.report.changedPaths).toEqual([]);
    expect((await lifecycle.check()).report.cacheHit).toBe(true);
  });

  it("blocks Stop once per unchanged blocking fingerprint", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "stop-session");
    await lifecycle.context();
    await introduceCycle(root);

    const first = await lifecycle.final();
    const second = await lifecycle.final();
    expect(first.shouldBlock).toBe(true);
    expect(first.stopAttemptsForFingerprint).toBe(1);
    expect(second.shouldBlock).toBe(false);
    expect(second.unresolvedCompletion).toBe(true);
    expect(second.stopAttemptsForFingerprint).toBe(1);

    await writeFile(
      path.join(root, "src", "a", "index.ts"),
      "export const a = 1;\n",
    );
    const repaired = await lifecycle.final();
    expect(repaired.report.status).toBe("pass");
    expect(repaired.shouldBlock).toBe(false);
    expect(repaired.unresolvedCompletion).toBe(false);
  });

  it("keeps session state isolated by worktree identity", async () => {
    const root = await fixture();
    const lifecycle = guard(root, "isolated-session");
    await lifecycle.context();
    const context = await resolveGitContext(root);
    const primary = new GrowthStateStore(
      context.gitDirectory,
      "isolated-session",
      context.repository,
    );
    const secondaryDirectory = path.join(
      root,
      ".git",
      "worktrees",
      "secondary",
    );
    await mkdir(secondaryDirectory, { recursive: true });
    const secondary = new GrowthStateStore(
      secondaryDirectory,
      "isolated-session",
      { ...context.repository, worktreeId: "f".repeat(64) },
    );

    expect(secondary.filePath).not.toBe(primary.filePath);
    expect(await primary.load()).not.toBeNull();
    expect(await secondary.load()).toBeNull();
  });

  it("does not mutate source, index, refs, HEAD, or worktree registrations", async () => {
    const root = await fixture();
    const indexPath = path.join(root, ".git", "index");
    const fingerprint = async () => ({
      source: await readFile(path.join(root, "src", "a", "index.ts"), "utf8"),
      index: createHash("sha256")
        .update(await readFile(indexPath))
        .digest("hex"),
      head: await git(root, "rev-parse", "HEAD"),
      refs: await git(root, "show-ref"),
      worktrees: await git(root, "worktree", "list", "--porcelain"),
    });
    const before = await fingerprint();
    const lifecycle = guard(root, "mutation-session");
    await lifecycle.context();
    await lifecycle.check();
    await lifecycle.final();

    expect(await fingerprint()).toEqual(before);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });
});
