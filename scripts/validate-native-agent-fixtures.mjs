#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(
  root,
  "packages",
  "guard",
  "test",
  "fixtures",
  "native",
);
const names = (await readdir(fixtureRoot)).filter((name) =>
  name.endsWith(".json"),
);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(names.length === 4, "Expected one deterministic fixture set per host");
for (const name of names) {
  const raw = await readFile(path.join(fixtureRoot, name), "utf8");
  const fixture = JSON.parse(raw);
  assert(
    ["codex", "claude", "gemini", "copilot"].includes(fixture.platform),
    `${name} has an unsupported platform`,
  );
  assert(
    /^\d+\.\d+\.\d+$/u.test(fixture.cliVersion),
    `${name} lacks a CLI version`,
  );
  assert(
    /^\d{4}-\d{2}-\d{2}$/u.test(fixture.captureDate),
    `${name} lacks a date`,
  );
  assert(fixture.redactionNote?.length > 20, `${name} lacks a redaction note`);
  assert(
    Array.isArray(fixture.events) && fixture.events.length === 4,
    `${name} lacks events`,
  );
  assert(
    !/\/Users\/|[A-Za-z]:\\Users\\/u.test(raw),
    `${name} contains a home path`,
  );
  assert(
    !/(github_pat_|ghp_|gho_|Bearer\s+[A-Za-z0-9])/u.test(raw),
    `${name} contains token-like text`,
  );
  assert(
    !/"(?:requestId|accountId|token)"\s*:/iu.test(raw),
    `${name} contains a forbidden identifier`,
  );
}

process.stdout.write("Native hook fixtures are sanitized and complete.\n");
