import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { GrowthModeAdapterCompatibility } from "@braid/core";

import type { GrowthGuardFactory } from "../contracts.js";
import { createGrowthGuard } from "../growth-guard.js";

const execFileAsync = promisify(execFile);

export const GROWTH_HOOK_FAIL_OPEN_MESSAGE =
  "Braid Growth Guard could not evaluate this event; continuing without a pass result. Review hook diagnostics and run `braid growth check`.";

export type GrowthLifecycleEvent =
  "session-start" | "prompt-submit" | "post-mutation" | "final-stop";

export interface GrowthLifecycleInput {
  event: GrowthLifecycleEvent;
  sessionId: string;
  cwd: string;
}

export type GrowthLifecycleResult =
  | { action: "context"; text: string }
  | { action: "allow"; message?: string }
  | { action: "block"; reason: string };

export interface HandleGrowthLifecycleOptions {
  compatibility: GrowthModeAdapterCompatibility;
  growthGuardFactory?: GrowthGuardFactory;
  resolveProjectRoot?: (cwd: string) => Promise<string>;
}

export const resolveGrowthProjectRoot = async (
  cwd: string,
): Promise<string> => {
  const resolvedCwd = await realpath(path.resolve(cwd));
  const result = await execFileAsync(
    "git",
    ["-C", resolvedCwd, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  const reportedRoot = result.stdout.trim();
  if (reportedRoot.length === 0) {
    throw new Error("Growth hook cwd is not inside a Git repository.");
  }
  const projectRoot = await realpath(reportedRoot);
  const relativeCwd = path.relative(projectRoot, resolvedCwd);
  if (relativeCwd.startsWith(`..${path.sep}`) || relativeCwd === "..") {
    throw new Error("Growth hook cwd resolved outside its Git root.");
  }
  const config = await stat(
    path.join(projectRoot, ".braid", "architecture.yaml"),
  );
  if (!config.isFile()) {
    throw new Error("Braid architecture configuration is not a file.");
  }
  return projectRoot;
};

const nonEmpty = (value: string): string => {
  if (value.trim().length === 0) {
    throw new Error("Growth Guard returned empty hook context.");
  }
  return value;
};

const visible = (value: string | null): string | null =>
  value !== null && value.trim().length > 0 ? value : null;

export const handleGrowthLifecycle = async (
  input: GrowthLifecycleInput,
  options: HandleGrowthLifecycleOptions,
): Promise<GrowthLifecycleResult> => {
  const projectRoot = await (
    options.resolveProjectRoot ?? resolveGrowthProjectRoot
  )(input.cwd);
  const guard = (options.growthGuardFactory ?? createGrowthGuard)({
    projectRoot,
    sessionId: input.sessionId,
    compatibility: options.compatibility,
  });

  if (input.event === "session-start" || input.event === "prompt-submit") {
    return { action: "context", text: nonEmpty((await guard.context()).text) };
  }
  if (input.event === "post-mutation") {
    const feedback = visible((await guard.check()).feedback);
    return feedback === null
      ? { action: "allow" }
      : { action: "context", text: feedback };
  }

  const result = await guard.final();
  const feedback = visible(result.feedback);
  if (result.shouldBlock) {
    return {
      action: "block",
      reason:
        feedback ??
        "Braid Growth Guard found a blocking architecture regression.",
    };
  }
  if (result.unresolvedCompletion) {
    return {
      action: "allow",
      message:
        feedback === null
          ? "Braid Growth Guard is allowing completion with an unresolved architecture regression already reported for this fingerprint."
          : `${feedback}\n\nCompletion is allowed because this unchanged regression fingerprint was already blocked once.`,
    };
  }
  return feedback === null
    ? { action: "allow" }
    : { action: "allow", message: feedback };
};
