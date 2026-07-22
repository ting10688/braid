#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scoped = [
  ".agents/plugins",
  ".claude-plugin",
  ".github/plugin",
  "adapters/native-agent",
  "commands/braid",
  "hooks",
  "plugins/braid",
  "plugins/braid-claude",
  "packages/guard/test/fixtures/native",
  "docs/native-agent-plugins.md",
];
const files = [];
const visit = async (entry) => {
  const metadata = await stat(entry);
  if (metadata.isDirectory()) {
    for (const name of await readdir(entry))
      await visit(path.join(entry, name));
  } else if (metadata.isFile()) files.push(entry);
};
for (const relative of scoped) await visit(path.join(root, relative));

const forbidden = [
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /github_pat_[A-Za-z0-9_]+/u,
  /\bgh[opsu]_[A-Za-z0-9]+/u,
  /\bBearer\s+[A-Za-z0-9._-]+/u,
  /"(?:accountId|requestId|accessToken|refreshToken)"\s*:/iu,
];
for (const file of files) {
  const value = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(value)) {
      throw new Error(
        `Sensitive-data pattern ${pattern} found in ${path.relative(root, file)}`,
      );
    }
  }
}

process.stdout.write(
  `Sensitive-data scan passed for ${files.length} native adapter files.\n`,
);
