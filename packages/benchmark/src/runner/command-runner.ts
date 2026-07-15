import { spawn } from "node:child_process";
import path from "node:path";
import type { CommandMeasurement, TimingSummary } from "../models/benchmark.js";

export interface CommandResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  redactions?: Readonly<Record<string, string>>;
}

const redact = (
  value: string,
  replacements: Readonly<Record<string, string>> = {},
): string =>
  Object.entries(replacements)
    .sort(([left], [right]) => right.length - left.length)
    .reduce(
      (current, [absolute, replacement]) =>
        current.replaceAll(absolute, replacement),
      value,
    );

export const runCommand = async (
  command: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> => {
  const [executable, ...arguments_] = command;
  if (!executable) throw new Error("Configured command must not be empty");
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: performance.now() - started,
        stdout: redact(stdout, options.redactions),
        stderr: redact(stderr, options.redactions),
        timedOut,
      });
    });
  });
};

export const timingSummary = (durations: readonly number[]): TimingSummary => {
  if (durations.length === 0)
    throw new Error("At least one duration is required");
  const sorted = [...durations].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
      : sorted[midpoint]!;
  return {
    medianMs,
    minimumMs: sorted[0]!,
    maximumMs: sorted.at(-1)!,
    repetitions: sorted.length,
  };
};

const parsedTestCount = (
  output: string,
  labels: readonly string[],
): number | null => {
  for (const label of labels) {
    const match = output.match(
      new RegExp(`(?:^|\\n)\\s*#?\\s*${label}\\s+(\\d+)`, "iu"),
    );
    if (match?.[1]) return Number(match[1]);
  }
  return null;
};

export const commandMeasurement = (
  correctnessResults: readonly CommandResult[],
  timingResults: readonly CommandResult[] = correctnessResults,
): CommandMeasurement => {
  const last = correctnessResults.at(-1);
  if (!last) throw new Error("At least one command result is required");
  if (timingResults.length === 0)
    throw new Error("At least one timing result is required");
  const output = `${last.stdout}\n${last.stderr}`;
  return {
    exitCodes: correctnessResults.map(({ exitCode }) => exitCode),
    timing: timingSummary(timingResults.map(({ durationMs }) => durationMs)),
    stdout: last.stdout,
    stderr: last.stderr,
    timedOut: [...correctnessResults, ...timingResults].some(
      ({ timedOut }) => timedOut,
    ),
    passingTests: parsedTestCount(output, ["pass", "passed", "tests passed"]),
    failingTests: parsedTestCount(output, ["fail", "failed", "tests failed"]),
  };
};

export const expandCommand = (
  command: readonly string[],
  workspaceRoot: string,
): string[] =>
  command.map((part) =>
    part.replaceAll("{workspaceRoot}", path.resolve(workspaceRoot)),
  );
