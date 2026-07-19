import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { MigrationSafetyError } from "@braid/shared";
import { notifyRecoveryInternalTestEvent } from "./recovery-support.js";
import { hashNormalizedPatch } from "./scope-policy.js";

const execFileAsync = promisify(execFile);

const gitRaw = async (
  worktreePath: string,
  arguments_: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> =>
  (
    await execFileAsync("git", ["-C", worktreePath, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(environment ? { env: environment } : {}),
    })
  ).stdout;

const git = async (
  worktreePath: string,
  arguments_: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> =>
  (await gitRaw(worktreePath, arguments_, environment)).trim();

const gitWithInput = async (
  worktreePath: string,
  arguments_: string[],
  input: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", worktreePath, ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else
        reject(
          new Error(
            `git ${arguments_[0] ?? "command"} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
    child.stdin.end(input);
  });

const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

export const assertExecutorDidNotCommit = async (
  worktreePath: string,
  baseCommit: string,
): Promise<void> => {
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (head !== baseCommit)
    throw new MigrationSafetyError(
      "Executor or validation command created an unauthorized commit",
      8,
      "executor-created-commit",
    );
};

export interface CandidateCommitPreparation {
  schemaVersion: 1;
  executionId: string;
  parent: string;
  tree: string;
  message: string;
  authorName: "Braid Migrator";
  authorEmail: "braid-migrator@example.invalid";
  committerName: "Braid Migrator";
  committerEmail: "braid-migrator@example.invalid";
  timestamp: number;
  timezone: "+0000";
  ref: string;
  expectedCommit: string;
  objectFormat: "sha1" | "sha256";
  changedFiles: string[];
  patchHash: string;
}

export interface PrepareCandidateCommitInput {
  worktreePath: string;
  baseCommit: string;
  candidateBranch: string;
  proposalId: string;
  executionId: string;
  planId: string;
  changedFiles: string[];
  expectedPatchHash: string;
  timestamp: number;
  indexDirectory?: string;
  indexOwnership?: unknown;
}

const assertCandidateInput = async (
  input: Omit<PrepareCandidateCommitInput, "timestamp">,
): Promise<string> => {
  await assertExecutorDidNotCommit(input.worktreePath, input.baseCommit);
  if (!/^braid\/exec\/[a-f0-9]{8}$/u.test(input.candidateBranch))
    throw new MigrationSafetyError(
      "Candidate branch identity is invalid",
      8,
      "candidate-branch-invalid",
    );
  if (!/^[a-f0-9]{64}$/u.test(input.expectedPatchHash))
    throw new MigrationSafetyError(
      "Validated patch identity is invalid",
      8,
      "candidate-patch-invalid",
    );
  const branchRef = await git(input.worktreePath, ["symbolic-ref", "HEAD"]);
  if (branchRef !== `refs/heads/${input.candidateBranch}`)
    throw new MigrationSafetyError(
      "Candidate worktree is not on its owned branch",
      8,
      "candidate-branch-mismatch",
    );
  return branchRef;
};

const commitMessage = (input: {
  proposalId: string;
  executionId: string;
  planId: string;
}): string =>
  `braid: execute ${input.proposalId}\n\nBraid-Proposal: ${input.proposalId}\nBraid-Execution: ${input.executionId}\nBraid-Plan: ${input.planId}\n`;

const commitContent = (input: CandidateCommitPreparation): string =>
  [
    `tree ${input.tree}`,
    `parent ${input.parent}`,
    `author ${input.authorName} <${input.authorEmail}> ${input.timestamp} ${input.timezone}`,
    `committer ${input.committerName} <${input.committerEmail}> ${input.timestamp} ${input.timezone}`,
    "",
    input.message,
  ].join("\n");

const hashGitObject = (
  format: "sha1" | "sha256",
  type: string,
  contents: string,
): string => {
  const bytes = Buffer.from(contents, "utf8");
  return createHash(format)
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

export const prepareCandidateCommit = async (
  input: PrepareCandidateCommitInput,
): Promise<CandidateCommitPreparation> => {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0)
    throw new MigrationSafetyError(
      "Candidate commit timestamp is invalid",
      8,
      "candidate-timestamp-invalid",
    );
  const branchRef = await assertCandidateInput(input);
  const expectedFiles = sorted(input.changedFiles);
  const temporaryIndexDirectory = input.indexDirectory
    ? path.resolve(input.indexDirectory)
    : await mkdtemp(path.join(tmpdir(), "braid-candidate-index-"));
  if (input.indexDirectory) await mkdir(temporaryIndexDirectory);
  const disabledHooks = path.join(temporaryIndexDirectory, "disabled-hooks");
  await mkdir(disabledHooks);
  if (input.indexOwnership !== undefined)
    await writeFile(
      path.join(temporaryIndexDirectory, "ownership.json"),
      `${JSON.stringify(input.indexOwnership, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  const hookless = ["-c", `core.hooksPath=${disabledHooks}`];
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporaryIndexDirectory, "index"),
  };
  try {
    await git(
      input.worktreePath,
      [...hookless, "read-tree", input.baseCommit],
      environment,
    );
    await git(
      input.worktreePath,
      [...hookless, "add", "--", ...expectedFiles],
      environment,
    );
    const staged = (
      await gitRaw(
        input.worktreePath,
        [...hookless, "diff", "--cached", "--name-only", "-z", "HEAD", "--"],
        environment,
      )
    )
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(staged) !== JSON.stringify(expectedFiles))
      throw new MigrationSafetyError(
        "Candidate tree files do not match the validated migration scope",
        8,
        "candidate-staging-mismatch",
      );
    const stagedPatch = await gitRaw(
      input.worktreePath,
      [
        ...hookless,
        "diff",
        "--cached",
        "HEAD",
        "--binary",
        "--no-ext-diff",
        "--no-color",
        "--unified=0",
        "--",
      ],
      environment,
    );
    if (hashNormalizedPatch(stagedPatch) !== input.expectedPatchHash)
      throw new MigrationSafetyError(
        "Candidate diff changed after validation",
        8,
        "candidate-diff-changed",
      );
    const unstaged = await gitRaw(
      input.worktreePath,
      [...hookless, "diff", "--name-only", "-z", "--"],
      environment,
    );
    if (unstaged)
      throw new MigrationSafetyError(
        "Candidate files changed while the validated tree was captured",
        8,
        "candidate-diff-changed",
      );
    const [tree, objectFormat] = await Promise.all([
      git(input.worktreePath, [...hookless, "write-tree"], environment),
      git(input.worktreePath, ["rev-parse", "--show-object-format"]),
    ]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
      throw new MigrationSafetyError(
        `Unsupported Git object format: ${objectFormat}`,
        8,
        "candidate-object-format-invalid",
      );
    const preparation: CandidateCommitPreparation = {
      schemaVersion: 1,
      executionId: input.executionId,
      parent: input.baseCommit,
      tree,
      message: commitMessage(input),
      authorName: "Braid Migrator",
      authorEmail: "braid-migrator@example.invalid",
      committerName: "Braid Migrator",
      committerEmail: "braid-migrator@example.invalid",
      timestamp: input.timestamp,
      timezone: "+0000",
      ref: branchRef,
      expectedCommit: "",
      objectFormat,
      changedFiles: expectedFiles,
      patchHash: input.expectedPatchHash,
    };
    preparation.expectedCommit = hashGitObject(
      objectFormat,
      "commit",
      commitContent(preparation),
    );
    return preparation;
  } finally {
    await rm(temporaryIndexDirectory, { recursive: true, force: true });
  }
};

const verifyPreparation = (preparation: CandidateCommitPreparation): void => {
  const expected = hashGitObject(
    preparation.objectFormat,
    "commit",
    commitContent(preparation),
  );
  if (expected !== preparation.expectedCommit)
    throw new MigrationSafetyError(
      "Prepared candidate commit identity is inconsistent",
      8,
      "candidate-preparation-invalid",
    );
};

export const createPreparedCandidateCommit = async (input: {
  worktreePath: string;
  preparation: CandidateCommitPreparation;
}): Promise<string> => {
  const { preparation } = input;
  verifyPreparation(preparation);
  const branchRef = await git(input.worktreePath, ["symbolic-ref", "HEAD"]);
  if (branchRef !== preparation.ref)
    throw new MigrationSafetyError(
      "Candidate worktree is not on the prepared ref",
      8,
      "candidate-branch-mismatch",
    );
  const hooksDirectory = path.join(
    tmpdir(),
    `braid-candidate-hooks-disabled-${randomUUID()}`,
  );
  const hookless = ["-c", `core.hooksPath=${hooksDirectory}`];
  try {
    let refCommit = await git(input.worktreePath, [
      "rev-parse",
      preparation.ref,
    ]);
    if (refCommit === preparation.parent) {
      const object = await gitWithInput(
        input.worktreePath,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        commitContent(preparation),
      );
      if (object !== preparation.expectedCommit)
        throw new MigrationSafetyError(
          "Created candidate object does not match prepared identity",
          8,
          "candidate-object-mismatch",
        );
      await notifyRecoveryInternalTestEvent("candidate-object-created");
      try {
        await git(input.worktreePath, [
          ...hookless,
          "update-ref",
          "--create-reflog",
          "-m",
          `braid candidate ${preparation.executionId}`,
          preparation.ref,
          preparation.expectedCommit,
          preparation.parent,
        ]);
      } catch (error) {
        refCommit = await git(input.worktreePath, [
          "rev-parse",
          preparation.ref,
        ]);
        if (refCommit !== preparation.expectedCommit) throw error;
      }
      await notifyRecoveryInternalTestEvent("candidate-ref-updated");
    } else if (refCommit !== preparation.expectedCommit) {
      throw new MigrationSafetyError(
        "Candidate ref points to a conflicting commit",
        8,
        "candidate-ref-conflict",
      );
    }
    await git(input.worktreePath, [
      ...hookless,
      "read-tree",
      "--reset",
      preparation.expectedCommit,
    ]);
    const [raw, parent, tree, status, changedFiles, finalRef] =
      await Promise.all([
        gitRaw(input.worktreePath, [
          "cat-file",
          "commit",
          preparation.expectedCommit,
        ]),
        git(input.worktreePath, [
          "rev-parse",
          `${preparation.expectedCommit}^`,
        ]),
        git(input.worktreePath, [
          "rev-parse",
          `${preparation.expectedCommit}^{tree}`,
        ]),
        git(input.worktreePath, [
          ...hookless,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        gitRaw(input.worktreePath, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          preparation.expectedCommit,
        ]),
        git(input.worktreePath, ["rev-parse", preparation.ref]),
      ]);
    const committedFiles = changedFiles
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    if (
      raw !== commitContent(preparation) ||
      parent !== preparation.parent ||
      tree !== preparation.tree ||
      finalRef !== preparation.expectedCommit
    )
      throw new MigrationSafetyError(
        "Candidate commit does not contain the prepared identity",
        8,
        "candidate-tree-mismatch",
      );
    if (
      JSON.stringify(committedFiles) !==
      JSON.stringify(preparation.changedFiles)
    )
      throw new MigrationSafetyError(
        "Candidate commit files do not match the validated migration scope",
        8,
        "candidate-staging-mismatch",
      );
    if (status)
      throw new MigrationSafetyError(
        "Candidate worktree changed during controlled commit creation",
        8,
        "candidate-post-commit-dirty",
      );
    return preparation.expectedCommit;
  } finally {
    await rm(hooksDirectory, { recursive: true, force: true });
  }
};

export const createCandidateCommit = async (
  input: Omit<PrepareCandidateCommitInput, "timestamp">,
): Promise<string> => {
  const preparation = await prepareCandidateCommit({
    ...input,
    timestamp: Math.floor(Date.now() / 1_000),
  });
  return createPreparedCandidateCommit({
    worktreePath: input.worktreePath,
    preparation,
  });
};
