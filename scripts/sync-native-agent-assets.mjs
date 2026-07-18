#!/usr/bin/env node
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "adapters", "native-agent", "runtime.mjs");
const targets = [path.join(root, "plugins", "braid", "runtime.mjs")];
const write = process.argv.includes("--write");
const canonical = await readFile(source);

for (const target of targets) {
  if (write) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    continue;
  }
  let generated;
  try {
    generated = await readFile(target);
  } catch {
    throw new Error(
      `Missing generated adapter asset: ${path.relative(root, target)}`,
    );
  }
  if (!generated.equals(canonical)) {
    throw new Error(
      `Generated adapter asset differs from canonical source: ${path.relative(root, target)}`,
    );
  }
}

process.stdout.write(
  write
    ? "Native adapter assets synchronized.\n"
    : "Native adapter assets are synchronized.\n",
);
