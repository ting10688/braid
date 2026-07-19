#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const canonicalName = "Freddy Lin";
const canonicalEmail = "87643334+ting10688@users.noreply.github.com";
const forbiddenIdentityHash =
  "3c6f6010efdbcea6ed4e2445351bc4fc17db6960904fd4653aca823e8304e87e";

const git = (...arguments_) =>
  execFileSync("git", arguments_, { encoding: "utf8" }).trimEnd();
const commits = git("rev-list", "HEAD", "--branches", "--tags")
  .split("\n")
  .filter(Boolean);

for (const commit of commits) {
  const identities = git(
    "show",
    "-s",
    "--format=%an%x00%ae%x00%cn%x00%ce",
    commit,
  ).split("\0");

  for (let index = 0; index < identities.length; index += 2) {
    const name = identities[index];
    const email = identities[index + 1];
    const digest = createHash("sha256")
      .update(`${name}\0${email}`)
      .digest("hex");
    if (
      digest === forbiddenIdentityHash ||
      (name === canonicalName && email !== canonicalEmail)
    ) {
      throw new Error(
        `Commit identity validation failed at ${commit.slice(0, 12)}.`,
      );
    }
  }
}

process.stdout.write(
  `Validated ${commits.length} reachable commit identities.\n`,
);
