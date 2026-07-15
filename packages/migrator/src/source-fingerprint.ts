import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
  sourceFingerprintSchema,
  type SourceFingerprint,
  type SourceManifestEntry,
} from "@braid/core";
import { MigrationSafetyError } from "@braid/shared";
import { SOURCE_FINGERPRINT_EXCLUDES } from "./safety.js";

const execFileAsync = promisify(execFile);
const compare = (left: string, right: string): number =>
  left.localeCompare(right);

const excluded = (relativePath: string): boolean =>
  SOURCE_FINGERPRINT_EXCLUDES.some(
    (prefix) =>
      relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
  );

const contentHash = (contents: string | Buffer): string =>
  createHash("sha256").update(contents).digest("hex");

export const createSourceFingerprint = async (
  repositoryRoot: string,
): Promise<SourceFingerprint> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "ls-files", "-z"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new MigrationSafetyError(
      "Cannot fingerprint source outside a Git repository",
      4,
      "source-fingerprint-unavailable",
      { cause: error },
    );
  }

  const entries: SourceManifestEntry[] = [];
  for (const relativePath of stdout.split("\0").filter(Boolean).sort(compare)) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (excluded(normalized)) continue;
    const absolutePath = path.join(repositoryRoot, relativePath);
    const metadata = await lstat(absolutePath);
    const fileType = metadata.isSymbolicLink() ? "symlink" : "file";
    const contents =
      fileType === "symlink"
        ? await readlink(absolutePath)
        : await readFile(absolutePath);
    entries.push({
      path: normalized,
      fileType,
      contentHash: contentHash(contents),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
  const hash = contentHash(
    JSON.stringify(
      entries.map((entry) => [
        entry.path,
        entry.fileType,
        entry.contentHash,
        entry.executable,
      ]),
    ),
  );
  return sourceFingerprintSchema.parse({
    schemaVersion: 1,
    algorithm: "sha256",
    hash,
    entries,
  });
};
