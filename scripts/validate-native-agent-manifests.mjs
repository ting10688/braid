#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(root, relative), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const walkFiles = async (relative) => {
  const directory = path.join(root, relative);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
};

const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
const copilotMarketplace = await readJson(".github/plugin/marketplace.json");
const codexManifest = await readJson("plugins/braid/.codex-plugin/plugin.json");
const copilotManifest = await readJson("plugins/braid/plugin.json");
const geminiManifest = await readJson("gemini-extension.json");
const codexHooks = await readJson("plugins/braid/hooks/codex.json");
const copilotHooks = await readJson("plugins/braid/hooks/copilot.json");
const geminiHooks = await readJson("hooks/hooks.json");

assert(
  codexMarketplace.name === "braid",
  "Codex marketplace name must be braid",
);
assert(
  codexMarketplace.plugins?.[0]?.source?.path === "./plugins/braid",
  "Codex marketplace must use its dedicated plugin directory",
);
assert(
  copilotMarketplace.plugins?.[0]?.source === "./plugins/braid",
  "Copilot marketplace must use its dedicated plugin directory",
);
for (const manifest of [codexManifest, copilotManifest, geminiManifest]) {
  assert(manifest.name === "braid", "Native manifest name must be braid");
  assert(manifest.version === "0.6.0", "Native manifest version must be 0.6.0");
}
assert(
  codexManifest.hooks === "./hooks/codex.json",
  "Codex must select only Codex hooks",
);
assert(
  copilotManifest.hooks === "hooks/copilot.json",
  "Copilot must select only Copilot hooks",
);

const expectedEvents = {
  codex: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
  gemini: ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"],
  copilot: ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"],
};
assert(
  JSON.stringify(Object.keys(expectedEvents)) ===
    JSON.stringify(["codex", "gemini", "copilot"]),
  "Production native host set must be exactly Codex, Gemini, and Copilot",
);
for (const [host, hooks] of Object.entries({
  codex: codexHooks,
  gemini: geminiHooks,
  copilot: copilotHooks,
})) {
  assert(
    JSON.stringify(Object.keys(hooks.hooks ?? {})) ===
      JSON.stringify(expectedEvents[host]),
    `${host} hook lifecycle differs from the verified contract`,
  );
  assert(
    !JSON.stringify(hooks).toLowerCase().includes("claude"),
    `${host} hook manifest must not claim Claude support`,
  );
}

const productionFiles = (
  await Promise.all(
    [
      ".agents/plugins",
      ".github/plugin",
      "adapters/native-agent",
      "commands/braid",
      "hooks",
      "plugins/braid",
    ].map(walkFiles),
  )
).flat();
assert(
  !productionFiles.some((file) => file.toLowerCase().includes("claude")),
  "Production packaging must not contain a Claude artifact",
);
assert(
  !(
    await Promise.all(
      productionFiles.map((relative) =>
        readFile(path.join(root, relative), "utf8"),
      ),
    )
  ).some((value) => /\bclaude\b/iu.test(value)),
  "Production packaging must not advertise Claude support",
);
const productionSource = await Promise.all(
  [
    "adapters/native-agent/runtime.mjs",
    "apps/cli/src/index.ts",
    "apps/cli/src/commands/growth.ts",
    "packages/guard/src/native/protocol.ts",
  ].map((relative) => readFile(path.join(root, relative), "utf8")),
);
assert(
  !productionSource.some((value) =>
    /(?:growth\s+(?:install|uninstall)|--host)\s+claude|["']claude["']/iu.test(
      value,
    ),
  ),
  "Production commands and host registries must not expose Claude",
);

for (const relative of [
  "plugins/braid/runtime.mjs",
  "plugins/braid/skills/setup/SKILL.md",
  "plugins/braid/commands/setup.toml",
  "commands/braid/setup.toml",
]) {
  await access(path.join(root, relative));
}

process.stdout.write("Native agent manifests are valid.\n");
