import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import {
  migrationExecutionPlanSchema,
  type MigrationExecutionPlan,
  type ScopeViolation,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";
import { containsSensitiveText } from "./safety.js";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const ZERO_MODE = "000000";
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

interface StatusRecord {
  path: string;
  originalPath?: string;
  xy: string;
  submodule: string;
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  untracked: boolean;
}

export interface RenamedFile {
  from: string;
  to: string;
}

export interface ModeChange {
  path: string;
  before: string;
  after: string;
}

export interface ScopeLineStats {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface ScopeInspection {
  compliant: boolean;
  patch: string;
  patchHash: string;
  changedFiles: string[];
  modifiedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  renamedFiles: RenamedFile[];
  binaryFiles: string[];
  symlinkChanges: string[];
  submoduleChanges: string[];
  modeChanges: ModeChange[];
  lineStats: ScopeLineStats[];
  violations: ScopeViolation[];
}

export interface InspectMigrationScopeInput {
  worktreeRoot: string;
  plan: MigrationExecutionPlan;
  publicEntrypoints?: readonly string[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort(compare);
const normalizedPath = (value: string): string => value.replaceAll("\\", "/");
const validRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  !value.split("/").some((segment) => ["", ".", ".."].includes(segment));
const executableMode = (mode: string): boolean =>
  mode !== ZERO_MODE && (Number.parseInt(mode.slice(-3), 8) & 0o111) !== 0;

export const hashNormalizedPatch = (rawPatch: string): string => {
  const normalized = rawPatch.replaceAll("\r\n", "\n");
  const sections = normalized
    .split(/(?=^diff --git )/gmu)
    .filter(Boolean)
    .map((section) => (section.endsWith("\n") ? section : `${section}\n`))
    .sort(compare);
  return createHash("sha256").update(sections.join("")).digest("hex");
};

const runGit = async (
  root: string,
  arguments_: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...arguments_],
      {
        cwd: root,
        encoding: "buffer",
        maxBuffer: MAX_GIT_OUTPUT,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof error.code === "number" ? error.code : 0;
        if (error && !allowedExitCodes.includes(exitCode)) {
          reject(
            new MigrationSafetyError(
              `Git diff inspection failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`,
              8,
              "git-diff-inspection-failed",
              { cause: error },
            ),
          );
          return;
        }
        resolve(Buffer.from(stdout).toString("utf8"));
      },
    );
  });

const parseStatus = (output: string): StatusRecord[] => {
  const tokens = output.split("\0");
  const records: StatusRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("? ")) {
      records.push({
        path: normalizedPath(token.slice(2)),
        xy: "??",
        submodule: "N...",
        headMode: ZERO_MODE,
        indexMode: ZERO_MODE,
        worktreeMode: ZERO_MODE,
        untracked: true,
      });
      continue;
    }
    const ordinary = token.match(
      /^1 ([^ ]+) ([^ ]+) ([0-9]{6}) ([0-9]{6}) ([0-9]{6}) [^ ]+ [^ ]+ (.+)$/u,
    );
    if (ordinary) {
      records.push({
        path: normalizedPath(ordinary[6]!),
        xy: ordinary[1]!,
        submodule: ordinary[2]!,
        headMode: ordinary[3]!,
        indexMode: ordinary[4]!,
        worktreeMode: ordinary[5]!,
        untracked: false,
      });
      continue;
    }
    const renamed = token.match(
      /^2 ([^ ]+) ([^ ]+) ([0-9]{6}) ([0-9]{6}) ([0-9]{6}) [^ ]+ [^ ]+ [^ ]+ (.+)$/u,
    );
    if (renamed) {
      records.push({
        path: normalizedPath(renamed[6]!),
        originalPath: normalizedPath(tokens[(index += 1)] ?? ""),
        xy: renamed[1]!,
        submodule: renamed[2]!,
        headMode: renamed[3]!,
        indexMode: renamed[4]!,
        worktreeMode: renamed[5]!,
        untracked: false,
      });
      continue;
    }
    const unmerged = token.match(
      /^u ([^ ]+) ([^ ]+) ([0-9]{6}) [0-9]{6} [0-9]{6} ([0-9]{6}) [^ ]+ [^ ]+ [^ ]+ (.+)$/u,
    );
    if (unmerged) {
      records.push({
        path: normalizedPath(unmerged[5]!),
        xy: unmerged[1]!,
        submodule: unmerged[2]!,
        headMode: unmerged[3]!,
        indexMode: unmerged[4]!,
        worktreeMode: unmerged[4]!,
        untracked: false,
      });
      continue;
    }
    throw new MigrationSafetyError(
      "Git returned an unsupported status record",
      8,
      "unsupported-git-status",
    );
  }
  return records;
};

const parseNameStatus = (output: string): RenamedFile[] => {
  const tokens = output.split("\0").filter(Boolean);
  const renamed: RenamedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]!;
    if (/^[RC][0-9]+$/u.test(status)) {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from && to)
        renamed.push({ from: normalizedPath(from), to: normalizedPath(to) });
    } else {
      index += 1;
    }
  }
  return renamed.sort(
    (left, right) =>
      compare(left.from, right.from) || compare(left.to, right.to),
  );
};

const parseNumstat = (output: string): ScopeLineStats[] => {
  const tokens = output.split("\0");
  const stats: ScopeLineStats[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const [added, deleted, file = ""] = token.split("\t");
    let target = file;
    if (!target) {
      index += 2;
      target = tokens[index] ?? "";
    }
    if (!target) continue;
    stats.push({
      path: normalizedPath(target),
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    });
  }
  return stats.sort((left, right) => compare(left.path, right.path));
};

const globRegex = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
};

export const pathMatchesPattern = (
  file: string,
  pattern: string,
  matchBasename = false,
): boolean =>
  globRegex(pattern).test(
    matchBasename && !pattern.includes("/") ? path.posix.basename(file) : file,
  );

const dependencyOrConfigPath = (file: string): boolean => {
  const basename = path.posix.basename(file);
  return (
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ].includes(basename) || /^tsconfig(?:\.[^.]+)*\.json$/u.test(basename)
  );
};

const addViolation = (
  violations: ScopeViolation[],
  code: ScopeViolation["code"],
  message: string,
  file?: string,
): void => {
  const candidate = {
    code,
    ...(file && validRelativePath(file) ? { path: file } : {}),
    message,
  } as ScopeViolation;
  if (
    !violations.some(
      (item) => item.code === candidate.code && item.path === candidate.path,
    )
  )
    violations.push(candidate);
};

const untrackedPatch = async (root: string, file: string): Promise<string> =>
  runGit(
    root,
    [
      "diff",
      "--no-index",
      "--binary",
      "--no-ext-diff",
      "--",
      "/dev/null",
      file,
    ],
    [0, 1],
  );

export const inspectMigrationScope = async (
  input: InspectMigrationScopeInput,
): Promise<ScopeInspection> => {
  const plan = migrationExecutionPlanSchema.parse(input.plan);
  const [
    statusOutput,
    ignoredOutput,
    trackedPatch,
    nameStatusOutput,
    numstatOutput,
  ] = await Promise.all([
    runGit(input.worktreeRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]),
    runGit(input.worktreeRoot, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
    runGit(input.worktreeRoot, [
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
      "--no-color",
      "--unified=0",
      "--",
    ]),
    runGit(input.worktreeRoot, [
      "diff",
      "HEAD",
      "--name-status",
      "-z",
      "--find-renames",
      "--",
    ]),
    runGit(input.worktreeRoot, ["diff", "HEAD", "--numstat", "-z", "--"]),
  ]);
  const publicEntrypointSet = new Set(
    (input.publicEntrypoints ?? []).map(normalizedPath),
  );
  const ignoredForbidden = ignoredOutput
    .split("\0")
    .filter(Boolean)
    .map(normalizedPath)
    .filter(
      (file) =>
        dependencyOrConfigPath(file) ||
        publicEntrypointSet.has(file) ||
        plan.scope.forbiddenFiles.some((pattern) =>
          pathMatchesPattern(file, pattern, true),
        ),
    )
    .map<StatusRecord>((file) => ({
      path: file,
      xy: "??",
      submodule: "N...",
      headMode: ZERO_MODE,
      indexMode: ZERO_MODE,
      worktreeMode: ZERO_MODE,
      untracked: true,
    }));
  const records = [...parseStatus(statusOutput), ...ignoredForbidden].filter(
    (record, index, values) =>
      values.findIndex((candidate) => candidate.path === record.path) === index,
  );
  const statusRenames = records
    .filter((record) => record.originalPath)
    .map((record) => ({ from: record.originalPath!, to: record.path }));
  const renamedFiles = [...parseNameStatus(nameStatusOutput), ...statusRenames]
    .filter(
      (item, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.from === item.from && candidate.to === item.to,
        ) === index,
    )
    .sort(
      (left, right) =>
        compare(left.from, right.from) || compare(left.to, right.to),
    );
  const added = new Set<string>();
  const deleted = new Set<string>();
  const modified = new Set<string>();
  const symlinks = new Set<string>();
  const submodules = new Set<string>();
  const modeChanges: ModeChange[] = [];
  const untracked = records.filter((record) => record.untracked);

  for (const record of records) {
    const change = record.xy;
    if (record.untracked || change.includes("A")) added.add(record.path);
    if (change.includes("D")) deleted.add(record.path);
    if (record.originalPath) {
      added.add(record.path);
      deleted.add(record.originalPath);
    }
    if (
      !record.untracked &&
      !change.includes("A") &&
      !change.includes("D") &&
      !record.originalPath
    )
      modified.add(record.path);
    if (
      record.submodule.startsWith("S") ||
      [record.headMode, record.indexMode, record.worktreeMode].includes(
        SUBMODULE_MODE,
      )
    )
      submodules.add(record.path);
    if (
      [record.headMode, record.indexMode, record.worktreeMode].includes(
        SYMLINK_MODE,
      )
    )
      symlinks.add(record.path);
    const currentMode =
      record.indexMode !== ZERO_MODE && record.indexMode !== record.headMode
        ? record.indexMode
        : record.worktreeMode !== ZERO_MODE
          ? record.worktreeMode
          : record.indexMode;
    if (
      record.headMode !== ZERO_MODE &&
      currentMode !== ZERO_MODE &&
      record.headMode !== currentMode &&
      record.headMode !== SYMLINK_MODE &&
      currentMode !== SYMLINK_MODE &&
      record.headMode !== SUBMODULE_MODE &&
      currentMode !== SUBMODULE_MODE
    )
      modeChanges.push({
        path: record.path,
        before: record.headMode,
        after: currentMode,
      });
    if (record.headMode === ZERO_MODE && executableMode(currentMode))
      modeChanges.push({
        path: record.path,
        before: ZERO_MODE,
        after: currentMode,
      });
  }

  const untrackedPatches: string[] = [];
  const untrackedStats: ScopeLineStats[] = [];
  for (const record of untracked.sort((left, right) =>
    compare(left.path, right.path),
  )) {
    const absolute = path.resolve(input.worktreeRoot, record.path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) symlinks.add(record.path);
    if (metadata.isFile() && (metadata.mode & 0o111) !== 0)
      modeChanges.push({
        path: record.path,
        before: ZERO_MODE,
        after: `100${(metadata.mode & 0o777).toString(8).padStart(3, "0")}`,
      });
    if (metadata.isDirectory()) continue;
    untrackedPatches.push(
      await untrackedPatch(input.worktreeRoot, record.path),
    );
    if (!metadata.isFile()) continue;
    const contents = await readFile(absolute);
    const binary = contents.includes(0);
    if (binary) {
      untrackedStats.push({
        path: record.path,
        additions: null,
        deletions: null,
      });
    } else {
      const additions =
        contents.length === 0
          ? 0
          : contents.reduce(
              (count, byte) => count + Number(byte === 0x0a),
              contents.at(-1) === 0x0a ? 0 : 1,
            );
      untrackedStats.push({ path: record.path, additions, deletions: 0 });
    }
  }

  const trackedStats = parseNumstat(numstatOutput);
  const lineStats = [...trackedStats, ...untrackedStats]
    .filter(
      (item, index, values) =>
        values.findIndex((candidate) => candidate.path === item.path) === index,
    )
    .sort((left, right) => compare(left.path, right.path));
  const binaryFiles = sorted(
    lineStats
      .filter((stat) => stat.additions === null || stat.deletions === null)
      .map((stat) => stat.path),
  );
  const addedFiles = sorted(added);
  const deletedFiles = sorted(deleted);
  const modifiedFiles = sorted(modified);
  const changedFiles = sorted([
    ...addedFiles,
    ...deletedFiles,
    ...modifiedFiles,
    ...renamedFiles.flatMap(({ from, to }) => [from, to]),
  ]);
  const publicEntrypoints = publicEntrypointSet;
  const allowedExisting = new Set([
    ...plan.scope.allowedExistingFiles,
    ...plan.scope.allowedTestFiles,
  ]);
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    if (!validRelativePath(file)) {
      addViolation(
        violations,
        "unauthorized-path",
        `Changed path is not a normalized project-relative path: ${JSON.stringify(file)}`,
      );
      continue;
    }
    const isAdded = added.has(file);
    const allowed = isAdded
      ? allowedExisting.has(file) ||
        plan.scope.allowedNewFilePatterns.some((pattern) =>
          pathMatchesPattern(file, pattern),
        )
      : allowedExisting.has(file);
    if (!allowed)
      addViolation(
        violations,
        "unauthorized-path",
        `Path is outside the approved migration scope: ${file}`,
        file,
      );
    if (dependencyOrConfigPath(file))
      addViolation(
        violations,
        path.posix.basename(file).startsWith("tsconfig")
          ? "forbidden-path"
          : "dependency-change",
        `Package, lockfile, or TypeScript configuration changes are forbidden: ${file}`,
        file,
      );
    else if (publicEntrypoints.has(file))
      addViolation(
        violations,
        "public-entrypoint-change",
        `Public entrypoint changes are forbidden: ${file}`,
        file,
      );
    else if (
      plan.scope.forbiddenFiles.some((pattern) =>
        pathMatchesPattern(file, pattern, true),
      )
    )
      addViolation(
        violations,
        "forbidden-path",
        `Path matches a forbidden pattern: ${file}`,
        file,
      );
  }
  for (const file of deletedFiles)
    addViolation(
      violations,
      "deleted-file",
      `File deletion is not permitted by Phase 3: ${file}`,
      file,
    );
  for (const file of binaryFiles)
    addViolation(
      violations,
      "binary-file",
      `Binary changes are not permitted: ${file}`,
      file,
    );
  for (const file of symlinks)
    addViolation(
      violations,
      "symlink-change",
      `Symlink additions or changes are not permitted: ${file}`,
      file,
    );
  for (const file of submodules)
    addViolation(
      violations,
      "submodule-change",
      `Submodule changes are not permitted: ${file}`,
      file,
    );
  for (const change of modeChanges)
    addViolation(
      violations,
      "mode-change",
      `File mode changes are not permitted: ${change.path} (${change.before} -> ${change.after})`,
      change.path,
    );
  if (changedFiles.length > plan.scope.maximumChangedFiles)
    addViolation(
      violations,
      "changed-file-limit",
      `Changed ${changedFiles.length} files; approved maximum is ${plan.scope.maximumChangedFiles}`,
    );

  const rawPatch = [trackedPatch, ...untrackedPatches]
    .filter(Boolean)
    .map((part) => (part.endsWith("\n") ? part : `${part}\n`))
    .join("");
  const changedPatchText = rawPatch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1))
    .join("\n");
  if (containsSensitiveText(changedPatchText))
    addViolation(
      violations,
      "secret-detected",
      "Candidate changes contain content that resembles a credential or secret",
    );

  violations.sort(
    (left, right) =>
      compare(left.code, right.code) ||
      compare(left.path ?? "", right.path ?? ""),
  );
  const patch = violations.length === 0 ? rawPatch : "";

  return {
    compliant: violations.length === 0,
    patch,
    patchHash: hashNormalizedPatch(rawPatch),
    changedFiles,
    modifiedFiles,
    addedFiles,
    deletedFiles,
    renamedFiles,
    binaryFiles,
    symlinkChanges: sorted(symlinks),
    submoduleChanges: sorted(submodules),
    modeChanges: modeChanges.sort((left, right) =>
      compare(left.path, right.path),
    ),
    lineStats,
    violations,
  };
};
