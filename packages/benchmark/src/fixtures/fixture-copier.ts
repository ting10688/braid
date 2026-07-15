import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../runner/command-runner.js";

const forbiddenEntries = new Set([".git", "node_modules"]);

export const copyFixture = async (
  templateDirectory: string,
): Promise<string> => {
  const entries = await readdir(templateDirectory);
  const forbidden = entries.find((entry) => forbiddenEntries.has(entry));
  if (forbidden)
    throw new Error(`Fixture template contains forbidden entry: ${forbidden}`);
  const workdir = await mkdtemp(path.join(tmpdir(), "braid-bench-"));
  await cp(templateDirectory, workdir, { recursive: true });
  return workdir;
};

export const initializeFixtureGit = async (
  workdir: string,
  timeoutMs: number,
): Promise<void> => {
  const commands = [
    ["git", "init", "--quiet"],
    ["git", "config", "user.name", "Braid Bench"],
    ["git", "config", "user.email", "benchmark@example.invalid"],
    ["git", "add", "."],
    ["git", "commit", "--quiet", "-m", "benchmark baseline"],
  ];
  for (const command of commands) {
    const result = await runCommand(command, {
      cwd: workdir,
      timeoutMs,
      environment: {
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Could not initialize fixture Git repository: ${result.stderr}`,
      );
  }
};

export const removeFixture = async (workdir: string): Promise<void> =>
  rm(workdir, { force: true, recursive: true });
