#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(root, relative), "utf8"));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
const copilotMarketplace = await readJson(".github/plugin/marketplace.json");
const codexManifest = await readJson("plugins/braid/.codex-plugin/plugin.json");
const claudeManifest = await readJson(
  "plugins/braid-claude/.claude-plugin/plugin.json",
);
const copilotManifest = await readJson("plugins/braid/plugin.json");
const geminiManifest = await readJson("gemini-extension.json");
const codexHooks = await readJson("plugins/braid/hooks/codex.json");
const claudeHooks = await readJson("plugins/braid-claude/hooks/hooks.json");
const copilotHooks = await readJson("plugins/braid/hooks/copilot.json");
const geminiHooks = await readJson("hooks/hooks.json");

assert(
  codexMarketplace.name === "braid",
  "Codex marketplace name must be braid",
);
assert(
  claudeMarketplace.plugins?.[0]?.source === "./plugins/braid-claude",
  "Claude marketplace must use its dedicated plugin directory",
);
assert(
  codexMarketplace.plugins?.[0]?.source?.path === "./plugins/braid",
  "Codex marketplace must use its dedicated plugin directory",
);
assert(
  copilotMarketplace.plugins?.[0]?.source === "./plugins/braid",
  "Copilot marketplace must use its dedicated plugin directory",
);
for (const manifest of [
  codexManifest,
  claudeManifest,
  copilotManifest,
  geminiManifest,
]) {
  assert(manifest.name === "braid", "Native manifest name must be braid");
  assert(manifest.version === "0.6.0", "Native manifest version must be 0.6.0");
}
assert(
  codexManifest.hooks === "./hooks/codex.json",
  "Codex must select only Codex hooks",
);
assert(
  claudeManifest.hooks === undefined,
  "Claude must auto-discover hooks/hooks.json exactly once",
);
assert(
  copilotManifest.hooks === "hooks/copilot.json",
  "Copilot must select only Copilot hooks",
);

const expectedEvents = {
  codex: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
  claude: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
  gemini: ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"],
  copilot: ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"],
};
assert(
  JSON.stringify(Object.keys(expectedEvents)) ===
    JSON.stringify(["codex", "claude", "gemini", "copilot"]),
  "Production native host set must include the four verified adapters",
);
for (const [host, hooks] of Object.entries({
  codex: codexHooks,
  claude: claudeHooks,
  gemini: geminiHooks,
  copilot: copilotHooks,
})) {
  assert(
    JSON.stringify(Object.keys(hooks.hooks ?? {})) ===
      JSON.stringify(expectedEvents[host]),
    `${host} hook lifecycle differs from the verified contract`,
  );
}

for (const relative of [
  "plugins/braid/runtime.mjs",
  "plugins/braid/skills/setup/SKILL.md",
  "plugins/braid/commands/setup.toml",
  "commands/braid/setup.toml",
  "plugins/braid-claude/.claude-plugin/plugin.json",
  "plugins/braid-claude/commands/setup.md",
  "plugins/braid-claude/hooks/hooks.json",
]) {
  await access(path.join(root, relative));
}

process.stdout.write("Native agent manifests are valid.\n");
