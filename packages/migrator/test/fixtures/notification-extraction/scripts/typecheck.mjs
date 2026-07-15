/* global URL, console, process */
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

const findTypeScript = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return findTypeScript(target);
      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    }),
  );
  return files.flat().sort();
};

const assertRelativeImportsResolve = async (file, source) => {
  const importPattern = /(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/gu;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    const target = path.resolve(path.dirname(file), specifier);
    await access(path.extname(target) ? target : `${target}.ts`);
  }
};

const files = [
  ...(await findTypeScript(path.join(root, "src"))),
  ...(await findTypeScript(path.join(root, "test"))),
];

for (const file of files) {
  const source = await readFile(file, "utf8");
  await assertRelativeImportsResolve(file, source);
  const javascript = stripTypeScriptTypes(source, { mode: "strip" });
  const syntax = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    { encoding: "utf8", input: javascript },
  );
  if (syntax.status !== 0) {
    process.stderr.write(`${path.relative(root, file)}\n${syntax.stderr}`);
    process.exit(syntax.status ?? 1);
  }
}

console.log(`typecheck: ${files.length} TypeScript files passed`);
