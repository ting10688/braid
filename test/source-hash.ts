import path from "node:path";
import { createHash } from "node:crypto";
import { access, glob, readFile, stat } from "node:fs/promises";

const fixedFiles = ["package.json", "tsconfig.json", "pnpm-lock.yaml"];

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const sourceHash = async (projectRoot: string): Promise<string> => {
  const files = new Set<string>();
  for (const pattern of ["src/**/*", "test/**/*", "tests/**/*"])
    for await (const file of glob(pattern, { cwd: projectRoot }))
      if ((await stat(path.join(projectRoot, file))).isFile()) files.add(file);
  for (const file of fixedFiles)
    if (await exists(path.join(projectRoot, file))) files.add(file);

  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path.join(projectRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
};
