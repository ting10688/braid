/* global URL, console, process */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const stages = [
  ["typecheck", ["scripts/typecheck.mjs"]],
  ["unit-test", ["--test", "test/order-service.test.ts"]],
  ["build", ["scripts/build.mjs"]],
];

for (const [name, arguments_] of stages) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`validate: ${name} passed`);
}
