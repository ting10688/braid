import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { GrowthModeReport, GrowthModeReportStatus } from "@braid/core";
import {
  createGrowthGuard,
  handleCodexHook,
  installCodexHooks,
  uninstallCodexHooks,
} from "@braid/guard";

export const GROWTH_MODE_SUITE_ID = "growth-mode-live-guard" as const;
export const GROWTH_MODE_SUITE_VERSION = "1.0.0" as const;
export const GROWTH_MODE_PROTOCOL_VERSION = "1.0.0" as const;

const CASE_IDS = [
  "baseline-initialization",
  "context-injection",
  "no-source-change",
  "safe-source-change",
  "new-cycle",
  "preexisting-cycle",
  "preexisting-cycle-removed",
  "oversized-threshold-crossed",
  "oversized-module-growth",
  "same-session-repair",
  "stop-blocks-once",
  "stop-no-loop",
  "shell-git-mutation",
  "untracked-typescript",
  "config-cache-invalidation",
  "worktree-isolation",
  "malformed-hook-fail-open",
  "analysis-failure-not-pass",
  "install-idempotent-preserves-hooks",
  "uninstall-owned-only",
] as const;

export type GrowthModeBenchmarkCaseId = (typeof CASE_IDS)[number];

type ActualStatus = GrowthModeReportStatus | "error";

interface CaseExpectation {
  status: GrowthModeReportStatus;
  rule: "new-cycle" | null;
}

const EXPECTATIONS: Record<GrowthModeBenchmarkCaseId, CaseExpectation> = {
  "baseline-initialization": { status: "pass", rule: null },
  "context-injection": { status: "pass", rule: null },
  "no-source-change": { status: "pass", rule: null },
  "safe-source-change": { status: "pass", rule: null },
  "new-cycle": { status: "block", rule: "new-cycle" },
  "preexisting-cycle": { status: "pass", rule: null },
  "preexisting-cycle-removed": { status: "pass", rule: null },
  "oversized-threshold-crossed": { status: "warn", rule: null },
  "oversized-module-growth": { status: "warn", rule: null },
  "same-session-repair": { status: "pass", rule: null },
  "stop-blocks-once": { status: "block", rule: "new-cycle" },
  "stop-no-loop": { status: "block", rule: "new-cycle" },
  "shell-git-mutation": { status: "block", rule: "new-cycle" },
  "untracked-typescript": { status: "pass", rule: null },
  "config-cache-invalidation": { status: "pass", rule: null },
  "worktree-isolation": { status: "pass", rule: null },
  "malformed-hook-fail-open": { status: "warn", rule: null },
  "analysis-failure-not-pass": { status: "warn", rule: null },
  "install-idempotent-preserves-hooks": { status: "pass", rule: null },
  "uninstall-owned-only": { status: "pass", rule: null },
};

export interface GrowthModeBenchmarkCaseResult {
  id: GrowthModeBenchmarkCaseId;
  expectedStatus: GrowthModeReportStatus;
  actualStatus: ActualStatus;
  expectedRule: "new-cycle" | null;
  actualRules: string[];
  classificationCorrect: boolean;
  newCycleExpected: boolean;
  newCycleDetected: boolean;
  deterministicReportId: boolean;
  noChangeSkipped: boolean | null;
  cacheCorrect: boolean | null;
  stopLoopPrevented: boolean | null;
  sourceMutatedByBraid: boolean;
  gitMutatedByBraid: boolean;
  existingHooksPreserved: boolean | null;
  requirementMet: boolean;
  passed: boolean;
}

export interface GrowthModeBenchmarkReport {
  suiteId: typeof GROWTH_MODE_SUITE_ID;
  suiteVersion: typeof GROWTH_MODE_SUITE_VERSION;
  protocolVersion: typeof GROWTH_MODE_PROTOCOL_VERSION;
  cases: GrowthModeBenchmarkCaseResult[];
  metrics: {
    totalCases: number;
    passedCases: number;
    classificationAccuracy: number;
    newCycleRecall: number;
    newCyclePrecision: number;
    falseBlocks: number;
    falseWarnings: number;
    deterministicReportIds: number;
    noChangeSkips: number;
    cacheCorrect: number;
    stopLoopPrevented: number;
    sourceMutationsByBraid: number;
    gitMutationsByBraid: number;
    existingHooksPreserved: number;
  };
  regressions: string[];
  warnings: string[];
}

interface FixtureOptions {
  cycle?: boolean;
  extraOrderFiles?: number;
  oversizedModuleFiles?: number;
}

interface Fixture {
  container: string;
  repositoryRoot: string;
}

interface RepositoryObservation {
  sourceHash: string;
  refs: string;
  index: string;
  worktrees: string;
}

interface MutationTracker {
  sourceMutated: boolean;
  gitMutated: boolean;
}

interface ScenarioResult {
  actualStatus: ActualStatus;
  actualRules: string[];
  deterministicReportId: boolean;
  noChangeSkipped?: boolean;
  cacheCorrect?: boolean;
  stopLoopPrevented?: boolean;
  existingHooksPreserved?: boolean;
  requirementMet: boolean;
}

const FIXED_TIME = new Date("2026-07-16T00:00:00.000Z");
const execFileAsync = promisify(execFile);
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const git = async (
  cwd: string,
  args: string[],
  options: { fixedIdentity?: boolean } = {},
): Promise<string> => {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.fixedIdentity
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-07-16T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-07-16T00:00:00Z",
        }
      : process.env,
  });
  return String(result.stdout);
};

const architectureConfig = (oversizedModuleFiles = 20): string => `project:
  language: typescript
  architecture_style: modular-monolith
source:
  include:
    - src/**/*.ts
  exclude:
    - "**/*.d.ts"
    - "**/node_modules/**"
constraints:
  circular_dependencies: forbidden
  public_api_changes: approval_required
  allow_new_dependencies: false
  preserve_existing_import_paths: true
thresholds:
  oversized_file_lines: 500
  oversized_module_files: ${oversizedModuleFiles}
  oversized_module_exports: 25
  max_module_dependencies: 8
protected_paths: []
modules: {}
migration:
  enabled: false
growthMode:
  enabled: true
  enforcement: block
  blockOn:
    - new-cycle
  warnOn:
    - oversized-threshold-crossed
    - oversized-module-growth
  maxFindings: 5
  maxFeedbackCharacters: 4000
  stopBlocksPerFingerprint: 1
`;

const orderSource = `import { b } from "../shared/b.js";
export const a = b;
`;
const sharedSource = (cycle = false): string =>
  cycle
    ? `import { a } from "../orders/a.js";
export const b = a;
`
    : `export const b = 1;
`;

const createFixture = async (
  options: FixtureOptions = {},
): Promise<Fixture> => {
  const container = await mkdtemp(
    path.join(tmpdir(), "braid-growth-benchmark-"),
  );
  const repositoryRoot = path.join(container, "repository");
  await mkdir(path.join(repositoryRoot, ".braid"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "src", "modules", "orders"), {
    recursive: true,
  });
  await mkdir(path.join(repositoryRoot, "src", "modules", "shared"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify({ name: "growth-benchmark", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, ".braid", "architecture.yaml"),
    architectureConfig(options.oversizedModuleFiles),
  );
  await writeFile(
    path.join(repositoryRoot, "src", "modules", "orders", "a.ts"),
    orderSource,
  );
  await writeFile(
    path.join(repositoryRoot, "src", "modules", "shared", "b.ts"),
    sharedSource(options.cycle),
  );
  for (let index = 0; index < (options.extraOrderFiles ?? 0); index += 1)
    await writeFile(
      path.join(
        repositoryRoot,
        "src",
        "modules",
        "orders",
        `existing-${index + 1}.ts`,
      ),
      `export const existing${index + 1} = ${index + 1};\n`,
    );

  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Braid Benchmark"]);
  await git(repositoryRoot, [
    "config",
    "user.email",
    "benchmark@example.invalid",
  ]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "fixture"], {
    fixedIdentity: true,
  });
  return { container, repositoryRoot };
};

const sourceHash = async (repositoryRoot: string): Promise<string> => {
  const listed = await git(repositoryRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "src",
  ]);
  const files = listed.split("\0").filter(Boolean).sort(compare);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    try {
      hash.update(await readFile(path.join(repositoryRoot, file)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
};

const observeRepository = async (
  repositoryRoot: string,
): Promise<RepositoryObservation> => ({
  sourceHash: await sourceHash(repositoryRoot),
  refs: await git(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname):%(objectname)",
  ]),
  index: await git(repositoryRoot, ["ls-files", "--stage", "-z"]),
  worktrees: await git(repositoryRoot, ["worktree", "list", "--porcelain"]),
});

const observeBraid = async <T>(
  tracker: MutationTracker,
  repositoryRoot: string,
  action: () => Promise<T>,
): Promise<T> => {
  const before = await observeRepository(repositoryRoot);
  try {
    return await action();
  } finally {
    const after = await observeRepository(repositoryRoot);
    tracker.sourceMutated ||= before.sourceHash !== after.sourceHash;
    tracker.gitMutated ||=
      before.refs !== after.refs ||
      before.index !== after.index ||
      before.worktrees !== after.worktrees;
  }
};

const reportRules = (report: GrowthModeReport): string[] =>
  [...new Set(report.findings.map(({ ruleId }) => ruleId))].sort(compare);

const createLifecycle = (
  repositoryRoot: string,
  id: GrowthModeBenchmarkCaseId,
) =>
  createGrowthGuard({
    projectRoot: repositoryRoot,
    sessionId: `growth-benchmark-${id}`,
    now: () => FIXED_TIME,
  });

const initialize = async (
  repositoryRoot: string,
  id: GrowthModeBenchmarkCaseId,
  tracker: MutationTracker,
) => {
  const guard = createLifecycle(repositoryRoot, id);
  const first = await observeBraid(tracker, repositoryRoot, () =>
    guard.context(),
  );
  const second = await observeBraid(tracker, repositoryRoot, () =>
    guard.context(),
  );
  return {
    guard,
    first,
    deterministicReportId: first.report.id === second.report.id,
  };
};

const addCycle = async (repositoryRoot: string): Promise<void> => {
  await writeFile(
    path.join(repositoryRoot, "src", "modules", "shared", "b.ts"),
    sharedSource(true),
  );
};

const removeCycle = async (repositoryRoot: string): Promise<void> => {
  await writeFile(
    path.join(repositoryRoot, "src", "modules", "shared", "b.ts"),
    sharedSource(false),
  );
};

const addSafeSourceChange = async (repositoryRoot: string): Promise<void> => {
  await writeFile(
    path.join(repositoryRoot, "src", "modules", "orders", "a.ts"),
    `${orderSource}export const safe = 2;\n`,
  );
};

const executeCoreScenario = async (
  id: GrowthModeBenchmarkCaseId,
  repositoryRoot: string,
  tracker: MutationTracker,
): Promise<ScenarioResult> => {
  const initialized = await initialize(repositoryRoot, id, tracker);
  const { guard } = initialized;

  switch (id) {
    case "baseline-initialization": {
      const status = await observeBraid(tracker, repositoryRoot, () =>
        guard.status(),
      );
      return {
        actualStatus: initialized.first.report.status,
        actualRules: reportRules(initialized.first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          initialized.first.initialized &&
          initialized.first.report.skippedReason === "baseline-initialized" &&
          status.baselineExists,
      };
    }
    case "context-injection":
      return {
        actualStatus: initialized.first.report.status,
        actualRules: reportRules(initialized.first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          initialized.first.text.length > 0 &&
          initialized.first.text.length <= 4_000 &&
          !initialized.first.text.includes(repositoryRoot),
      };
    case "no-source-change": {
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      const second = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      const noChange = first.report.skippedReason === "no-relevant-change";
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: first.report.id === second.report.id,
        noChangeSkipped: noChange,
        cacheCorrect: noChange && first.report.cacheHit,
        requirementMet: noChange && first.feedback === null,
      };
    }
    case "safe-source-change": {
      await addSafeSourceChange(repositoryRoot);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.changedPaths.includes("src/modules/orders/a.ts") &&
          first.report.status === "pass",
      };
    }
    case "new-cycle": {
      await addCycle(repositoryRoot);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "block" &&
          reportRules(first.report).includes("new-cycle"),
      };
    }
    case "preexisting-cycle": {
      await writeFile(
        path.join(repositoryRoot, "src", "modules", "shared", "safe.ts"),
        "export const safe = true;\n",
      );
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "pass" &&
          !reportRules(first.report).includes("new-cycle"),
      };
    }
    case "preexisting-cycle-removed": {
      await removeCycle(repositoryRoot);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "pass" &&
          reportRules(first.report).includes("pre-existing-issue-removed"),
      };
    }
    case "oversized-threshold-crossed":
    case "oversized-module-growth": {
      const newPath = path.join(
        repositoryRoot,
        "src",
        "modules",
        "orders",
        "growth.ts",
      );
      await writeFile(newPath, "export const growth = true;\n");
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      const expectedRule =
        id === "oversized-threshold-crossed"
          ? "oversized-threshold-crossed"
          : "oversized-module-growth";
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "warn" &&
          reportRules(first.report).includes(expectedRule),
      };
    }
    case "same-session-repair": {
      await addCycle(repositoryRoot);
      const blocked = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      await removeCycle(repositoryRoot);
      const repaired = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: repaired.report.status,
        actualRules: reportRules(repaired.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          blocked.report.status === "block" &&
          repaired.report.status === "pass",
      };
    }
    case "stop-blocks-once": {
      await addCycle(repositoryRoot);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.final(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "block" &&
          first.shouldBlock &&
          first.stopAttemptsForFingerprint === 1,
      };
    }
    case "stop-no-loop": {
      await addCycle(repositoryRoot);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.final(),
      );
      const second = await observeBraid(tracker, repositoryRoot, () =>
        guard.final(),
      );
      const prevented =
        first.shouldBlock && !second.shouldBlock && second.unresolvedCompletion;
      return {
        actualStatus: second.report.status,
        actualRules: reportRules(second.report),
        deterministicReportId: initialized.deterministicReportId,
        stopLoopPrevented: prevented,
        requirementMet: prevented,
      };
    }
    case "shell-git-mutation": {
      const patchPath = path.join(path.dirname(repositoryRoot), "cycle.patch");
      await writeFile(
        patchPath,
        `diff --git a/src/modules/shared/b.ts b/src/modules/shared/b.ts
index 45bd5ec..2a67770 100644
--- a/src/modules/shared/b.ts
+++ b/src/modules/shared/b.ts
@@ -1 +1,2 @@
+import { a } from "../orders/a.js";
 export const b = 1;
`,
      );
      await git(repositoryRoot, ["apply", patchPath]);
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "block" &&
          reportRules(first.report).includes("new-cycle"),
      };
    }
    case "untracked-typescript": {
      const relativePath = "src/modules/orders/untracked.ts";
      await writeFile(
        path.join(repositoryRoot, relativePath),
        "export const untracked = true;\n",
      );
      const first = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      return {
        actualStatus: first.report.status,
        actualRules: reportRules(first.report),
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          first.report.status === "pass" &&
          first.report.changedPaths.includes(relativePath),
      };
    }
    case "config-cache-invalidation": {
      const cached = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      await writeFile(
        path.join(repositoryRoot, ".braid", "architecture.yaml"),
        architectureConfig(21),
      );
      const changed = await observeBraid(tracker, repositoryRoot, () =>
        guard.check(),
      );
      const cacheCorrect =
        cached.report.skippedReason === "no-relevant-change" &&
        cached.report.cacheHit &&
        changed.report.skippedReason !== "no-relevant-change" &&
        !changed.report.cacheHit;
      return {
        actualStatus: changed.report.status,
        actualRules: reportRules(changed.report),
        deterministicReportId: initialized.deterministicReportId,
        cacheCorrect,
        requirementMet:
          cacheCorrect &&
          changed.report.diffFingerprint !== cached.report.diffFingerprint,
      };
    }
    default:
      throw new Error(`Unsupported core benchmark case: ${id}`);
  }
};

const executeWorktreeScenario = async (
  fixture: Fixture,
  tracker: MutationTracker,
): Promise<ScenarioResult> => {
  const id = "worktree-isolation" as const;
  const linkedRoot = path.join(fixture.container, "linked");
  await git(fixture.repositoryRoot, ["branch", "growth-linked"]);
  await git(fixture.repositoryRoot, [
    "worktree",
    "add",
    linkedRoot,
    "growth-linked",
  ]);
  const linkedTracker: MutationTracker = {
    sourceMutated: false,
    gitMutated: false,
  };
  const main = await initialize(fixture.repositoryRoot, id, tracker);
  const linked = await initialize(linkedRoot, id, linkedTracker);
  await addSafeSourceChange(fixture.repositoryRoot);
  const mainCheck = await observeBraid(tracker, fixture.repositoryRoot, () =>
    main.guard.check(),
  );
  const linkedCheck = await observeBraid(linkedTracker, linkedRoot, () =>
    linked.guard.check(),
  );
  tracker.sourceMutated ||= linkedTracker.sourceMutated;
  tracker.gitMutated ||= linkedTracker.gitMutated;
  return {
    actualStatus: linkedCheck.report.status,
    actualRules: reportRules(linkedCheck.report),
    deterministicReportId:
      main.deterministicReportId && linked.deterministicReportId,
    requirementMet:
      main.first.report.repository.worktreeId !==
        linked.first.report.repository.worktreeId &&
      mainCheck.report.skippedReason !== "no-relevant-change" &&
      linkedCheck.report.skippedReason === "no-relevant-change",
  };
};

const validPostToolInput = (
  repositoryRoot: string,
  id: GrowthModeBenchmarkCaseId,
) => ({
  session_id: `growth-benchmark-${id}`,
  transcript_path: null,
  cwd: repositoryRoot,
  model: "gpt-5.4",
  turn_id: "benchmark-turn",
  permission_mode: "never",
  hook_event_name: "PostToolUse" as const,
  tool_name: "apply_patch",
  tool_use_id: "benchmark-tool-use",
  tool_input: {},
  tool_response: {},
});

const fakeCodexCommand = async (
  _command: string,
  arguments_: readonly string[],
): Promise<{ stdout: string }> => {
  if (arguments_.length === 1 && arguments_[0] === "--version")
    return { stdout: "codex-cli 0.144.2\n" };
  if (arguments_.join("\0") === "features\0list")
    return { stdout: "hooks stable true\n" };
  throw new Error("Unexpected Codex capability probe command.");
};

const existingHooksDocument = (): string =>
  `${JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "existing-hook-command",
                statusMessage: "Existing hook",
              },
            ],
          },
        ],
      },
      existingMetadata: { preserved: true },
    },
    null,
    2,
  )}\n`;

const writeExistingHooks = async (repositoryRoot: string): Promise<string> => {
  const raw = existingHooksDocument();
  await mkdir(path.join(repositoryRoot, ".codex"), { recursive: true });
  await writeFile(path.join(repositoryRoot, ".codex", "hooks.json"), raw);
  return raw;
};

const warningOutput = (output: Awaited<ReturnType<typeof handleCodexHook>>) =>
  "systemMessage" in output &&
  typeof output.systemMessage === "string" &&
  output.systemMessage.includes("without a pass result");

const executeAdapterScenario = async (
  id: GrowthModeBenchmarkCaseId,
  repositoryRoot: string,
  tracker: MutationTracker,
): Promise<ScenarioResult> => {
  const initialized = await initialize(repositoryRoot, id, tracker);
  switch (id) {
    case "malformed-hook-fail-open": {
      const diagnostics: string[] = [];
      const output = await observeBraid(tracker, repositoryRoot, () =>
        handleCodexHook(
          {
            hook_event_name: "PostToolUse",
            session_id: "",
          },
          { diagnostics: (message) => diagnostics.push(message) },
        ),
      );
      const visible = warningOutput(output);
      return {
        actualStatus: visible ? "warn" : "error",
        actualRules: visible ? ["analysis-incomplete"] : [],
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          visible &&
          "continue" in output &&
          output.continue &&
          diagnostics.length === 1,
      };
    }
    case "analysis-failure-not-pass": {
      await writeFile(
        path.join(repositoryRoot, ".braid", "architecture.yaml"),
        "growthMode: invalid\n",
      );
      const diagnostics: string[] = [];
      const output = await observeBraid(tracker, repositoryRoot, () =>
        handleCodexHook(validPostToolInput(repositoryRoot, id), {
          diagnostics: (message) => diagnostics.push(message),
        }),
      );
      const visible = warningOutput(output);
      return {
        actualStatus: visible ? "warn" : "error",
        actualRules: visible ? ["analysis-incomplete"] : [],
        deterministicReportId: initialized.deterministicReportId,
        requirementMet:
          visible &&
          "continue" in output &&
          output.continue &&
          diagnostics.length === 1,
      };
    }
    case "install-idempotent-preserves-hooks": {
      const original = await writeExistingHooks(repositoryRoot);
      const options = {
        projectRoot: repositoryRoot,
        launcher: ["braid", "growth", "hook"],
        confirm: true,
        runCommand: fakeCodexCommand,
      };
      const first = await observeBraid(tracker, repositoryRoot, () =>
        installCodexHooks(options),
      );
      const second = await observeBraid(tracker, repositoryRoot, () =>
        installCodexHooks(options),
      );
      const installed = await readFile(
        path.join(repositoryRoot, ".codex", "hooks.json"),
        "utf8",
      );
      const backup =
        first.backupPath === null
          ? null
          : await readFile(first.backupPath, "utf8");
      const preserved =
        installed.includes("existing-hook-command") &&
        installed.includes('"preserved": true') &&
        backup === original;
      return {
        actualStatus:
          first.changed && !second.changed && first.installed && preserved
            ? "pass"
            : "error",
        actualRules: [],
        deterministicReportId: initialized.deterministicReportId,
        existingHooksPreserved: preserved,
        requirementMet:
          first.changed &&
          !second.changed &&
          first.ownedHandlerCount === 4 &&
          second.ownedHandlerCount === 4 &&
          preserved,
      };
    }
    case "uninstall-owned-only": {
      await writeExistingHooks(repositoryRoot);
      const installed = await observeBraid(tracker, repositoryRoot, () =>
        installCodexHooks({
          projectRoot: repositoryRoot,
          launcher: ["braid", "growth", "hook"],
          confirm: true,
          runCommand: fakeCodexCommand,
        }),
      );
      const uninstalled = await observeBraid(tracker, repositoryRoot, () =>
        uninstallCodexHooks({ projectRoot: repositoryRoot }),
      );
      const current = await readFile(
        path.join(repositoryRoot, ".codex", "hooks.json"),
        "utf8",
      );
      const preserved =
        current.includes("existing-hook-command") &&
        current.includes('"preserved": true') &&
        !current.includes("BRAID_GROWTH_HOOK_OWNER");
      return {
        actualStatus:
          installed.installed &&
          uninstalled.changed &&
          uninstalled.removedHandlerCount === 4 &&
          preserved
            ? "pass"
            : "error",
        actualRules: [],
        deterministicReportId: initialized.deterministicReportId,
        existingHooksPreserved: preserved,
        requirementMet:
          installed.ownedHandlerCount === 4 &&
          uninstalled.ownedHandlerCount === 0 &&
          uninstalled.removedHandlerCount === 4 &&
          preserved,
      };
    }
    default:
      throw new Error(`Unsupported adapter benchmark case: ${id}`);
  }
};

const fixtureOptionsFor = (id: GrowthModeBenchmarkCaseId): FixtureOptions => {
  switch (id) {
    case "preexisting-cycle":
    case "preexisting-cycle-removed":
      return { cycle: true };
    case "oversized-threshold-crossed":
      return { oversizedModuleFiles: 1 };
    case "oversized-module-growth":
      return { oversizedModuleFiles: 1, extraOrderFiles: 1 };
    default:
      return {};
  }
};

const runCase = async (
  id: GrowthModeBenchmarkCaseId,
): Promise<GrowthModeBenchmarkCaseResult> => {
  const expectation = EXPECTATIONS[id];
  const fixture = await createFixture(fixtureOptionsFor(id));
  const tracker: MutationTracker = {
    sourceMutated: false,
    gitMutated: false,
  };
  let scenario: ScenarioResult;
  try {
    if (id === "worktree-isolation")
      scenario = await executeWorktreeScenario(fixture, tracker);
    else if (
      [
        "malformed-hook-fail-open",
        "analysis-failure-not-pass",
        "install-idempotent-preserves-hooks",
        "uninstall-owned-only",
      ].includes(id)
    )
      scenario = await executeAdapterScenario(
        id,
        fixture.repositoryRoot,
        tracker,
      );
    else
      scenario = await executeCoreScenario(id, fixture.repositoryRoot, tracker);
  } catch {
    scenario = {
      actualStatus: "error",
      actualRules: [],
      deterministicReportId: false,
      requirementMet: false,
    };
  } finally {
    await rm(fixture.container, { recursive: true, force: true });
  }

  const classificationCorrect = scenario.actualStatus === expectation.status;
  const newCycleExpected = expectation.rule === "new-cycle";
  const newCycleDetected = scenario.actualRules.includes("new-cycle");
  const passed =
    classificationCorrect &&
    (!newCycleExpected || newCycleDetected) &&
    scenario.deterministicReportId &&
    !tracker.sourceMutated &&
    !tracker.gitMutated &&
    scenario.requirementMet;
  return {
    id,
    expectedStatus: expectation.status,
    actualStatus: scenario.actualStatus,
    expectedRule: expectation.rule,
    actualRules: scenario.actualRules,
    classificationCorrect,
    newCycleExpected,
    newCycleDetected,
    deterministicReportId: scenario.deterministicReportId,
    noChangeSkipped: scenario.noChangeSkipped ?? null,
    cacheCorrect: scenario.cacheCorrect ?? null,
    stopLoopPrevented: scenario.stopLoopPrevented ?? null,
    sourceMutatedByBraid: tracker.sourceMutated,
    gitMutatedByBraid: tracker.gitMutated,
    existingHooksPreserved: scenario.existingHooksPreserved ?? null,
    requirementMet: scenario.requirementMet,
    passed,
  };
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

export const runGrowthModeBenchmark =
  async (): Promise<GrowthModeBenchmarkReport> => {
    const started = performance.now();
    const cases: GrowthModeBenchmarkCaseResult[] = [];
    for (const id of CASE_IDS) cases.push(await runCase(id));

    const expectedCycles = cases.filter(
      ({ newCycleExpected }) => newCycleExpected,
    );
    const detectedCycles = cases.filter(
      ({ newCycleDetected }) => newCycleDetected,
    );
    const truePositiveCycles = cases.filter(
      ({ newCycleExpected, newCycleDetected }) =>
        newCycleExpected && newCycleDetected,
    );
    const metrics = {
      totalCases: cases.length,
      passedCases: cases.filter(({ passed }) => passed).length,
      classificationAccuracy: ratio(
        cases.filter(({ classificationCorrect }) => classificationCorrect)
          .length,
        cases.length,
      ),
      newCycleRecall: ratio(truePositiveCycles.length, expectedCycles.length),
      newCyclePrecision: ratio(
        truePositiveCycles.length,
        detectedCycles.length,
      ),
      falseBlocks: cases.filter(
        ({ expectedStatus, actualStatus }) =>
          expectedStatus !== "block" && actualStatus === "block",
      ).length,
      falseWarnings: cases.filter(
        ({ expectedStatus, actualStatus }) =>
          expectedStatus === "pass" && actualStatus === "warn",
      ).length,
      deterministicReportIds: cases.filter(
        ({ deterministicReportId }) => deterministicReportId,
      ).length,
      noChangeSkips: cases.filter(
        ({ noChangeSkipped }) => noChangeSkipped === true,
      ).length,
      cacheCorrect: cases.filter(({ cacheCorrect }) => cacheCorrect === true)
        .length,
      stopLoopPrevented: cases.filter(
        ({ stopLoopPrevented }) => stopLoopPrevented === true,
      ).length,
      sourceMutationsByBraid: cases.filter(
        ({ sourceMutatedByBraid }) => sourceMutatedByBraid,
      ).length,
      gitMutationsByBraid: cases.filter(
        ({ gitMutatedByBraid }) => gitMutatedByBraid,
      ).length,
      existingHooksPreserved: cases.filter(
        ({ existingHooksPreserved }) => existingHooksPreserved === true,
      ).length,
    };
    const regressions = cases
      .filter(({ passed }) => !passed)
      .map(({ id }) => `Growth Mode case failed: ${id}`);
    const elapsed = performance.now() - started;
    return {
      suiteId: GROWTH_MODE_SUITE_ID,
      suiteVersion: GROWTH_MODE_SUITE_VERSION,
      protocolVersion: GROWTH_MODE_PROTOCOL_VERSION,
      cases,
      metrics,
      regressions,
      warnings:
        elapsed > 60_000
          ? [
              `Wall-clock runtime ${Math.round(elapsed)}ms exceeded the informational 60000ms target.`,
            ]
          : [],
    };
  };

export const formatGrowthModeBenchmark = (
  report: GrowthModeBenchmarkReport,
): string => {
  const summary = `${report.suiteId}@${report.suiteVersion}: ${report.metrics.passedCases}/${report.metrics.totalCases} passed`;
  const quality = `classification=${report.metrics.classificationAccuracy.toFixed(3)} new-cycle recall=${report.metrics.newCycleRecall.toFixed(3)} precision=${report.metrics.newCyclePrecision.toFixed(3)}`;
  return report.regressions.length === 0
    ? `${summary}\n${quality}`
    : `${summary}\n${quality}\n${report.regressions.join("\n")}`;
};
