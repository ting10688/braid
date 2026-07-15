import { createHash } from "node:crypto";
import { glob, readFile, stat } from "node:fs/promises";
import path from "node:path";

const sourcePatterns = [
  "src/**/*",
  "test/**/*",
  "tests/**/*",
  "package.json",
  "tsconfig.json",
  "pnpm-lock.yaml",
  ".braid/architecture.yaml",
];

const ignored =
  /(?:^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)|(?:^|\/)\.braid\/state(?:\/|$)/u;

export interface TreeHash {
  digest: string;
  files: Readonly<Record<string, string>>;
}

export const hashSourceTree = async (root: string): Promise<TreeHash> => {
  const files: Record<string, string> = {};
  for await (const relative of glob(sourcePatterns, { cwd: root })) {
    const normalized = relative.replaceAll(path.sep, "/");
    if (ignored.test(normalized)) continue;
    const absolute = path.join(root, relative);
    if (!(await stat(absolute)).isFile()) continue;
    files[normalized] = createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
  }
  const ordered = Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    digest: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    files: Object.fromEntries(ordered),
  };
};

export const changedFiles = (before: TreeHash, after: TreeHash): string[] =>
  [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((file) => before.files[file] !== after.files[file])
    .sort();
