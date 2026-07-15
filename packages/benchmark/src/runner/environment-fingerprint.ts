import os from "node:os";
import path from "node:path";
import type { EnvironmentFingerprint } from "../models/benchmark.js";
import { runCommand } from "./command-runner.js";

const output = async (
  command: readonly string[],
  cwd: string,
): Promise<string> => {
  const result = await runCommand(command, { cwd, timeoutMs: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() : "unknown";
};

export const gitCommit = async (root: string): Promise<string | null> => {
  const value = await output(["git", "rev-parse", "HEAD"], root);
  return value === "unknown" || value === "" ? null : value;
};

export const environmentFingerprint = async (
  workspaceRoot: string,
): Promise<EnvironmentFingerprint> => ({
  operatingSystem: `${os.platform()} ${os.release()}`,
  architecture: os.arch(),
  nodeVersion: process.version,
  pnpmVersion: await output(["pnpm", "--version"], workspaceRoot),
  gitVersion: await output(["git", "--version"], workspaceRoot),
  cpuModel: os.cpus()[0]?.model ?? null,
  logicalCpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
});

export const normalizedCommand = (
  command: readonly string[],
  workspaceRoot: string,
): string =>
  command
    .map((part) => part.replaceAll(path.resolve(workspaceRoot), "<workspace>"))
    .join(" ");
