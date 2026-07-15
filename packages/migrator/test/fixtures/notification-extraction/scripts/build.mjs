/* global URL, console */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const sourceRoot = path.join(root, "src");
const outputRoot = path.join(root, "dist");

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

await rm(outputRoot, { recursive: true, force: true });
const files = await findTypeScript(sourceRoot);

for (const file of files) {
  const relative = path.relative(sourceRoot, file).replace(/\.ts$/u, ".js");
  const output = path.join(outputRoot, relative);
  const source = await readFile(file, "utf8");
  const javascript = stripTypeScriptTypes(source, { mode: "strip" }).replace(
    /((?:from\s+|import\s*\()["'][^"']+)\.ts(["'])/gu,
    "$1.js$2",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, javascript);
}

await import(
  pathToFileURL(path.join(outputRoot, "orders", "order-service.js"))
);
console.log(`build: emitted ${files.length} JavaScript files`);
