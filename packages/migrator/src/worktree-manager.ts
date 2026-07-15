import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { EXECUTIONS_DIRECTORY, MigrationSafetyError } from "@braid/shared";

const execFileAsync = promisify(execFile);

export interface OwnedWorktree {
  executionId: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  proposalId?: string;
  planId?: string;
  initialReflog: string;
  candidateCommit?: string;
  discardedAt?: string;
}

interface WorktreeManagerOptions {
  repositoryRoot: string;
  executionRoot: string;
}

const executionShortId = (executionId: string): string =>
  executionId.replace(/^E-/u, "").replaceAll("-", "").slice(0, 8);

export const candidateBranchForExecution = (executionId: string): string =>
  `braid/exec/${executionShortId(executionId)}`;

const runGit = async (
  repositoryRoot: string,
  arguments_: string[],
): Promise<string> =>
  (
    await execFileAsync("git", ["-C", repositoryRoot, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim();

const atomicJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const controlledCandidateCommit = async (
  repositoryRoot: string,
  locator: OwnedWorktree,
  candidateCommit: string,
): Promise<boolean> => {
  if (!locator.proposalId || !locator.planId) return false;
  try {
    const [parent, count, message, author] = await Promise.all([
      runGit(repositoryRoot, ["rev-parse", `${candidateCommit}^`]),
      runGit(repositoryRoot, [
        "rev-list",
        "--count",
        `${locator.baseCommit}..${candidateCommit}`,
      ]),
      runGit(repositoryRoot, ["show", "-s", "--format=%B", candidateCommit]),
      runGit(repositoryRoot, [
        "show",
        "-s",
        "--format=%an%x00%ae",
        candidateCommit,
      ]),
    ]);
    const lines = new Set(message.split("\n"));
    return (
      parent === locator.baseCommit &&
      count === "1" &&
      author === "Braid Migrator\0braid-migrator@example.invalid" &&
      lines.has(`braid: execute ${locator.proposalId}`) &&
      lines.has(`Braid-Proposal: ${locator.proposalId}`) &&
      lines.has(`Braid-Execution: ${locator.executionId}`) &&
      lines.has(`Braid-Plan: ${locator.planId}`)
    );
  } catch {
    return false;
  }
};

const reflogFor = async (
  repositoryRoot: string,
  branch: string,
): Promise<string> =>
  runGit(repositoryRoot, [
    "reflog",
    "show",
    "--format=%H%x00%gs",
    branch,
  ]).catch(() => "");

const expectedCandidateReflog = (
  locator: OwnedWorktree,
  candidateCommit: string,
): string =>
  `${candidateCommit}\0braid candidate ${locator.executionId}${
    locator.initialReflog ? `\n${locator.initialReflog}` : ""
  }`;

export const defaultExecutionRoot = (repositoryRoot: string): string =>
  path.join(
    path.dirname(repositoryRoot),
    ".braid-worktrees",
    `${path.basename(repositoryRoot)}-${createHash("sha256")
      .update(path.resolve(repositoryRoot))
      .digest("hex")
      .slice(0, 8)}`,
  );

export class WorktreeManager {
  private readonly repositoryRoot: string;
  private readonly executionRoot: string;

  constructor(options: WorktreeManagerOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.executionRoot = path.resolve(options.executionRoot);
    const relative = path.relative(this.repositoryRoot, this.executionRoot);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    )
      throw new MigrationSafetyError(
        "Execution worktrees must be outside the main checkout",
        6,
        "worktree-inside-main",
      );
  }

  private locatorPath(executionId: string): string {
    return path.join(
      this.repositoryRoot,
      EXECUTIONS_DIRECTORY,
      executionId,
      "locator.local.json",
    );
  }

  private async canonicalRoots(): Promise<{
    repositoryRoot: string;
    executionRoot: string;
  }> {
    await mkdir(this.executionRoot, { recursive: true });
    const [repositoryRoot, executionRoot] = await Promise.all([
      realpath(this.repositoryRoot),
      realpath(this.executionRoot),
    ]);
    const relative = path.relative(repositoryRoot, executionRoot);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    )
      throw new MigrationSafetyError(
        "Execution worktrees must resolve outside the main checkout",
        6,
        "worktree-inside-main",
      );
    return { repositoryRoot, executionRoot };
  }

  async create(
    executionId: string,
    baseCommit: string,
    ownership: { proposalId: string; planId: string } | undefined = undefined,
  ): Promise<OwnedWorktree> {
    if (!/^E-[0-9a-f-]{36}$/u.test(executionId))
      throw new MigrationSafetyError(
        `Invalid execution ID: ${executionId}`,
        6,
        "invalid-execution-id",
      );
    if (await pathExists(this.locatorPath(executionId)))
      throw new MigrationSafetyError(
        `Execution already owns worktree metadata: ${executionId}`,
        6,
        "execution-already-owned",
      );
    const roots = await this.canonicalRoots();
    const topLevel = await realpath(
      await runGit(this.repositoryRoot, ["rev-parse", "--show-toplevel"]),
    );
    if (topLevel !== roots.repositoryRoot)
      throw new MigrationSafetyError(
        "Worktree manager repository root does not match Git top-level",
        6,
        "repository-root-mismatch",
      );
    try {
      await runGit(this.repositoryRoot, [
        "cat-file",
        "-e",
        `${baseCommit}^{commit}`,
      ]);
    } catch (error) {
      throw new MigrationSafetyError(
        `Base commit does not exist: ${baseCommit}`,
        6,
        "base-commit-missing",
        { cause: error },
      );
    }
    const branch = candidateBranchForExecution(executionId);
    const worktreePath = path.join(this.executionRoot, executionId);
    if (await runGit(this.repositoryRoot, ["branch", "--list", branch]))
      throw new MigrationSafetyError(
        `Candidate branch already exists: ${branch}`,
        6,
        "candidate-branch-exists",
      );
    const remoteBefore = await runGit(this.repositoryRoot, [
      "config",
      "--local",
      "--get-regexp",
      "^remote\\.",
    ]).catch(() => "");
    const emptyHooks = await mkdtemp(
      path.join(tmpdir(), "braid-worktree-hooks-disabled-"),
    );
    try {
      await runGit(this.repositoryRoot, [
        "-c",
        `core.hooksPath=${emptyHooks}`,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        baseCommit,
      ]);
    } catch (error) {
      throw new MigrationSafetyError(
        "Could not create isolated migration worktree",
        6,
        "worktree-create-failed",
        { cause: error },
      );
    } finally {
      await rm(emptyHooks, { recursive: true, force: true });
    }
    const [actualCommit, status, remoteAfter] = await Promise.all([
      runGit(worktreePath, ["rev-parse", "HEAD"]),
      runGit(worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
      runGit(this.repositoryRoot, [
        "config",
        "--local",
        "--get-regexp",
        "^remote\\.",
      ]).catch(() => ""),
    ]);
    const actualWorktree = await realpath(worktreePath).catch(() => "");
    const relativeToExecutionRoot = path.relative(
      roots.executionRoot,
      actualWorktree,
    );
    const relativeToRepository = path.relative(
      roots.repositoryRoot,
      actualWorktree,
    );
    if (
      actualCommit !== baseCommit ||
      status !== "" ||
      remoteAfter !== remoteBefore ||
      !actualWorktree ||
      relativeToExecutionRoot.startsWith("..") ||
      path.isAbsolute(relativeToExecutionRoot) ||
      relativeToRepository === "" ||
      (!relativeToRepository.startsWith("..") &&
        !path.isAbsolute(relativeToRepository))
    ) {
      await runGit(this.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).catch(() => undefined);
      await runGit(this.repositoryRoot, ["branch", "-D", branch]).catch(
        () => undefined,
      );
      throw new MigrationSafetyError(
        "Created worktree failed base, cleanliness, or remote-integrity verification",
        6,
        "worktree-verification-failed",
      );
    }
    const locator: OwnedWorktree = {
      executionId,
      worktreePath,
      branch,
      baseCommit,
      initialReflog: await reflogFor(this.repositoryRoot, branch),
      ...(ownership ?? {}),
    };
    try {
      await atomicJson(this.locatorPath(executionId), locator);
    } catch (error) {
      await runGit(this.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).catch(() => undefined);
      await runGit(this.repositoryRoot, ["branch", "-D", branch]).catch(
        () => undefined,
      );
      throw new MigrationSafetyError(
        "Could not persist migration worktree ownership",
        6,
        "worktree-ownership-failed",
        { cause: error },
      );
    }
    return locator;
  }

  async load(executionId: string): Promise<OwnedWorktree> {
    let locator: OwnedWorktree;
    try {
      locator = JSON.parse(
        await readFile(this.locatorPath(executionId), "utf8"),
      ) as OwnedWorktree;
    } catch (error) {
      throw new MigrationSafetyError(
        `No owned worktree for ${executionId}`,
        12,
        "unknown-worktree",
        { cause: error },
      );
    }
    const expectedBranch = candidateBranchForExecution(executionId);
    const expectedPath = path.join(this.executionRoot, executionId);
    const relative = path.relative(this.executionRoot, locator.worktreePath);
    if (
      locator.executionId !== executionId ||
      locator.branch !== expectedBranch ||
      path.resolve(locator.worktreePath) !== expectedPath ||
      typeof locator.initialReflog !== "string" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      throw new MigrationSafetyError(
        "Worktree ownership metadata is invalid",
        12,
        "invalid-worktree-ownership",
      );
    return locator;
  }

  async gitDirectory(executionId: string): Promise<string> {
    const locator = await this.load(executionId);
    const gitDirectory = await runGit(locator.worktreePath, [
      "rev-parse",
      "--git-dir",
    ]);
    return realpath(path.resolve(locator.worktreePath, gitDirectory));
  }

  async assertOwnedState(
    executionId: string,
    expectedCommit: string,
  ): Promise<void> {
    const locator = await this.load(executionId);
    const [symbolicHead, head, branchCommit, commitCount, reflog] =
      await Promise.all([
        runGit(locator.worktreePath, ["symbolic-ref", "HEAD"]).catch(() => ""),
        runGit(locator.worktreePath, ["rev-parse", "HEAD"]).catch(() => ""),
        runGit(this.repositoryRoot, ["rev-parse", locator.branch]).catch(
          () => "",
        ),
        runGit(this.repositoryRoot, [
          "rev-list",
          "--count",
          `${locator.baseCommit}..${locator.branch}`,
        ]).catch(() => "-1"),
        reflogFor(this.repositoryRoot, locator.branch),
      ]);
    const expectsCandidate = expectedCommit !== locator.baseCommit;
    const controlled = expectsCandidate
      ? locator.candidateCommit === expectedCommit &&
        (await controlledCandidateCommit(
          this.repositoryRoot,
          locator,
          expectedCommit,
        ))
      : expectedCommit === locator.baseCommit;
    const expectedReflog = expectsCandidate
      ? expectedCandidateReflog(locator, expectedCommit)
      : locator.initialReflog;
    if (
      symbolicHead !== `refs/heads/${locator.branch}` ||
      head !== expectedCommit ||
      branchCommit !== expectedCommit ||
      Number(commitCount) !== (expectsCandidate ? 1 : 0) ||
      reflog !== expectedReflog ||
      !controlled
    )
      throw new MigrationSafetyError(
        "Owned candidate branch, HEAD, ancestry, or reflog changed unexpectedly",
        8,
        "owned-worktree-state-changed",
      );
  }

  async recordCandidateCommit(
    executionId: string,
    candidateCommit: string,
  ): Promise<void> {
    const locator = await this.load(executionId);
    if (!/^[a-f0-9]{40,64}$/u.test(candidateCommit))
      throw new MigrationSafetyError(
        "Candidate commit identity is invalid",
        12,
        "invalid-candidate-commit",
      );
    const [branchCommit, controlled, reflog] = await Promise.all([
      runGit(this.repositoryRoot, ["rev-parse", locator.branch]),
      controlledCandidateCommit(this.repositoryRoot, locator, candidateCommit),
      reflogFor(this.repositoryRoot, locator.branch),
    ]);
    if (
      branchCommit !== candidateCommit ||
      !controlled ||
      reflog !== expectedCandidateReflog(locator, candidateCommit)
    )
      throw new MigrationSafetyError(
        "Candidate commit is not the single owned child of the base commit",
        12,
        "unowned-candidate-commit",
      );
    await atomicJson(this.locatorPath(executionId), {
      ...locator,
      candidateCommit,
    });
  }

  async discard(executionId: string): Promise<void> {
    const locator = await this.load(executionId);
    if (locator.discardedAt) return;
    const roots = await this.canonicalRoots();
    const worktreeExists = await pathExists(locator.worktreePath);
    const branchCommit = await runGit(this.repositoryRoot, [
      "rev-parse",
      locator.branch,
    ]).catch(() => "");
    if (!branchCommit) {
      if (worktreeExists)
        throw new MigrationSafetyError(
          "Owned worktree exists without its candidate branch",
          12,
          "partial-discard-state",
        );
      await atomicJson(this.locatorPath(executionId), {
        ...locator,
        discardedAt: new Date().toISOString(),
      });
      return;
    }
    let candidateCommit = locator.candidateCommit;
    if (
      !candidateCommit &&
      (await controlledCandidateCommit(
        this.repositoryRoot,
        locator,
        branchCommit,
      )) &&
      (await reflogFor(this.repositoryRoot, locator.branch)) ===
        expectedCandidateReflog(locator, branchCommit)
    )
      candidateCommit = branchCommit;
    const allowedCommits = new Set(
      [locator.baseCommit, candidateCommit].filter(
        (value): value is string => value !== undefined,
      ),
    );
    const commitCount = Number(
      await runGit(this.repositoryRoot, [
        "rev-list",
        "--count",
        `${locator.baseCommit}..${locator.branch}`,
      ]).catch(() => "-1"),
    );
    if (
      !allowedCommits.has(branchCommit) ||
      commitCount < 0 ||
      commitCount > (candidateCommit ? 1 : 0)
    )
      throw new MigrationSafetyError(
        "Candidate branch contains unowned commits",
        12,
        "unowned-branch-commit",
      );
    if (worktreeExists) {
      const actualWorktree = await realpath(locator.worktreePath);
      const relativeToExecutionRoot = path.relative(
        roots.executionRoot,
        actualWorktree,
      );
      const relativeToRepository = path.relative(
        roots.repositoryRoot,
        actualWorktree,
      );
      if (
        relativeToExecutionRoot.startsWith("..") ||
        path.isAbsolute(relativeToExecutionRoot) ||
        relativeToRepository === "" ||
        (!relativeToRepository.startsWith("..") &&
          !path.isAbsolute(relativeToRepository))
      )
        throw new MigrationSafetyError(
          "Owned worktree resolved outside its safe execution root",
          12,
          "invalid-worktree-ownership",
        );
    }
    try {
      if (worktreeExists)
        await runGit(this.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          locator.worktreePath,
        ]);
      await runGit(this.repositoryRoot, ["branch", "-D", locator.branch]);
    } catch (error) {
      throw new MigrationSafetyError(
        "Could not safely discard execution worktree",
        12,
        "discard-failed",
        { cause: error },
      );
    }
    await atomicJson(this.locatorPath(executionId), {
      ...locator,
      ...(candidateCommit ? { candidateCommit } : {}),
      discardedAt: new Date().toISOString(),
    });
  }
}
