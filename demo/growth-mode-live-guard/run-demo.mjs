import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const demoDirectory = path.dirname(fileURLToPath(import.meta.url));
const distributionRoot = path.resolve(demoDirectory, "..");
const cli = path.join(distributionRoot, "bin", "braid.mjs");
const fixture = path.join(demoDirectory, "fixture");
const actions = path.join(demoDirectory, "actions");
const sessionId = "braid-hackathon-demo-v1";
const keep = process.argv.slice(2).includes("--keep");
const unknown = process.argv
  .slice(2)
  .filter((argument) => argument !== "--keep");
if (unknown.length > 0)
  throw new Error(`Unknown demo option: ${unknown.join(", ")}`);

await access(cli);
await access(fixture);

const temporary = await mkdtemp(path.join(tmpdir(), "braid-judge-demo-"));
const repository = path.join(temporary, "repository");
let succeeded = false;
let cleanupFailure;
let braidSourceMutations = 0;
let braidGitMutations = 0;

const run = async (command, arguments_, cwd = repository) => {
  const result = await execFileAsync(command, arguments_, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NO_PROXY: "*",
      no_proxy: "*",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
    },
  });
  return result.stdout.trim();
};

const git = (...arguments_) => run("git", arguments_);

const sourceFingerprint = async () => {
  const files = [];
  for await (const file of glob("src/**/*.ts", { cwd: repository }))
    files.push(file);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file).update("\0");
    hash.update(await readFile(path.join(repository, file))).update("\0");
  }
  return hash.digest("hex");
};

const observe = async () => ({
  source: await sourceFingerprint(),
  index: await git("ls-files", "--stage", "-z"),
  head: await git("rev-parse", "HEAD"),
  refs: await git("for-each-ref", "--format=%(refname):%(objectname)"),
  worktrees: await git("worktree", "list", "--porcelain"),
});

const runBraid = async (...arguments_) => {
  const before = await observe();
  const output = await run(process.execPath, [cli, ...arguments_]);
  const after = await observe();
  if (before.source !== after.source) braidSourceMutations += 1;
  if (
    before.index !== after.index ||
    before.head !== after.head ||
    before.refs !== after.refs ||
    before.worktrees !== after.worktrees
  )
    braidGitMutations += 1;
  return JSON.parse(output);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  await cp(fixture, repository, { recursive: true });
  await run(
    "git",
    ["init", "--quiet", "--initial-branch=main", repository],
    temporary,
  );
  await git("config", "user.name", "Braid Judge Demo");
  await git("config", "user.email", "demo@example.invalid");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "healthy baseline");
  const initial = await observe();

  process.stdout.write("BRAID DEMO — LIVE ARCHITECTURE GUARD\n\n");

  const context = await runBraid(
    "growth",
    "context",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  assert(context.initialized === true, "Expected a newly initialized baseline");
  assert(context.report.status === "pass", "Expected healthy baseline to pass");
  process.stdout.write("1. Baseline captured\n   Status: PASS\n\n");

  await run(process.execPath, [
    path.join(actions, "introduce-cycle.mjs"),
    repository,
  ]);
  process.stdout.write(
    "2. Demo setup action introduced a cycle\n   New edge: notifications -> orders\n\n",
  );

  const blocked = await runBraid(
    "growth",
    "check",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  const newCycle = blocked.findings.find(
    (finding) => finding.ruleId === "new-cycle",
  );
  assert(blocked.status === "block", "Expected introduced cycle to block");
  assert(newCycle, "Expected a real new-cycle finding");
  process.stdout.write(
    `3. Growth Mode check\n   Status: BLOCK\n   New cycle: ${newCycle.files.join(" -> ")}\n\n`,
  );

  const firstFinal = await runBraid(
    "growth",
    "final",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  const secondFinal = await runBraid(
    "growth",
    "final",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  assert(
    firstFinal.shouldBlock === true,
    "Expected first final check to block",
  );
  assert(
    secondFinal.shouldBlock === false &&
      secondFinal.unresolvedCompletion === true,
    "Expected repeated final check to avoid an infinite block loop",
  );
  process.stdout.write(
    "4. Stop-equivalent policy\n   First attempt: BLOCKED\n   Unchanged retry: ALLOWED WITH VISIBLE UNRESOLVED FINDING\n\n",
  );

  await run(process.execPath, [
    path.join(actions, "repair-cycle.mjs"),
    repository,
  ]);
  process.stdout.write("5. Demo setup action repaired the cycle\n\n");

  const repaired = await runBraid(
    "growth",
    "check",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  const final = await runBraid(
    "growth",
    "final",
    "--path",
    repository,
    "--session",
    sessionId,
    "--json",
  );
  assert(repaired.status === "pass", "Expected repaired source to pass");
  assert(
    final.report.status === "pass" && final.shouldBlock === false,
    "Expected final pass",
  );

  const completed = await observe();
  assert(
    completed.source === initial.source,
    "Demo actions did not restore source contents",
  );
  assert(completed.index === initial.index, "Git index changed during demo");
  assert(completed.head === initial.head, "HEAD changed during demo");
  assert(completed.refs === initial.refs, "Git refs changed during demo");
  assert(
    completed.worktrees === initial.worktrees,
    "Git worktrees changed during demo",
  );
  assert(braidSourceMutations === 0, "Braid modified demo source");
  assert(braidGitMutations === 0, "Braid modified protected Git state");

  process.stdout.write(
    "6. Final check\n   Status: PASS\n   No new architecture regressions\n\n",
  );
  process.stdout.write(`Braid source mutations: ${braidSourceMutations}\n`);
  process.stdout.write(`Braid Git mutations: ${braidGitMutations}\n`);
  succeeded = true;
} finally {
  if (keep) {
    process.stdout.write(`Temporary repository kept: ${repository}\n`);
  } else {
    await rm(temporary, { recursive: true, force: true });
    cleanupFailure = await access(temporary).then(
      () => new Error("Temporary repository cleanup failed"),
      (error) =>
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? undefined
          : error,
    );
    process.stdout.write("Temporary repository cleaned: yes\n");
  }
}

if (cleanupFailure) throw cleanupFailure;
if (!succeeded) process.exitCode = 1;
