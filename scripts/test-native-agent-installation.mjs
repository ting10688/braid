#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const braidCli = path.join(root, "apps", "cli", "dist", "index.js");
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "braid-native-install-"),
);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const cleanEnvironment = () => {
  const environment = { ...process.env };
  for (const name of [
    "CODEX_HOME",
    "COPILOT_HOME",
    "COPILOT_CACHE_HOME",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GEMINI_CLI_HOME",
    "GOOGLE_API_KEY",
  ]) {
    delete environment[name];
  }
  return environment;
};
const run = async (command, arguments_, environment, input = "") =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) child.kill("SIGKILL");
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else {
        const operation = arguments_
          .filter((argument) => argument !== root && !path.isAbsolute(argument))
          .slice(0, 4)
          .join(" ");
        reject(new Error(`${command} ${operation} failed with code ${code}`));
      }
    });
    child.stdin.end(input);
  });

const assertBraidSetup = async (host, environment) => {
  const result = await run(
    process.execPath,
    [
      braidCli,
      "growth",
      "setup",
      "--host",
      host,
      "--path",
      temporaryRoot,
      "--json",
    ],
    environment,
  );
  const status = JSON.parse(result.stdout);
  assert(status.host?.supported === true, `${host} contract was not supported`);
  assert(
    status.adapter?.discovered === true,
    `${host} adapter was not discovered by Braid setup`,
  );
  assert(
    status.project?.initialized === false,
    `${host} setup mutated or misread a non-Braid directory`,
  );
};

const hashIfPresent = async (file) => {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};
const realSettings = [
  path.join(homedir(), ".codex", "config.toml"),
  path.join(homedir(), ".copilot", "config.json"),
  path.join(homedir(), ".gemini", "settings.json"),
];
const settingsBefore = await Promise.all(realSettings.map(hashIfPresent));

try {
  const base = cleanEnvironment();

  const codexRoot = path.join(temporaryRoot, "codex");
  await mkdir(path.join(codexRoot, "home"), { recursive: true });
  const codexEnvironment = {
    ...base,
    HOME: path.join(codexRoot, "home"),
    CODEX_HOME: path.join(codexRoot, "config"),
  };
  await mkdir(codexEnvironment.CODEX_HOME, { recursive: true });
  await run(
    "codex",
    ["plugin", "marketplace", "add", root, "--json"],
    codexEnvironment,
  );
  const codexAvailable = await run(
    "codex",
    ["plugin", "list", "--available", "--json"],
    codexEnvironment,
  );
  assert(
    codexAvailable.stdout.includes('"pluginId": "braid@braid"'),
    "Codex marketplace did not discover Braid",
  );
  await run(
    "codex",
    ["plugin", "add", "braid@braid", "--json"],
    codexEnvironment,
  );
  await assertBraidSetup("codex", codexEnvironment);
  // Codex 0.144.5 intentionally refuses to upgrade a local marketplace.
  await run(
    "codex",
    ["plugin", "remove", "braid@braid", "--json"],
    codexEnvironment,
  );
  await run(
    "codex",
    ["plugin", "add", "braid@braid", "--json"],
    codexEnvironment,
  );
  await run(
    "codex",
    ["plugin", "remove", "braid@braid", "--json"],
    codexEnvironment,
  );
  await run(
    "codex",
    ["plugin", "marketplace", "remove", "braid"],
    codexEnvironment,
  );

  const copilotRoot = path.join(temporaryRoot, "copilot");
  await mkdir(path.join(copilotRoot, "home"), { recursive: true });
  const copilotEnvironment = {
    ...base,
    HOME: path.join(copilotRoot, "home"),
    COPILOT_HOME: path.join(copilotRoot, "config"),
    COPILOT_CACHE_HOME: path.join(copilotRoot, "cache"),
  };
  await run(
    "copilot",
    ["plugin", "marketplace", "add", root],
    copilotEnvironment,
  );
  await run(
    "copilot",
    ["plugin", "install", "braid@braid"],
    copilotEnvironment,
  );
  await assertBraidSetup("copilot", copilotEnvironment);
  const copilotList = await run(
    "copilot",
    ["plugin", "list"],
    copilotEnvironment,
  );
  assert(
    copilotList.stdout.includes("braid@braid"),
    "Copilot did not discover the installed Braid plugin",
  );
  await run("copilot", ["plugin", "update", "braid@braid"], copilotEnvironment);
  await run(
    "copilot",
    ["plugin", "uninstall", "braid@braid"],
    copilotEnvironment,
  );
  await run(
    "copilot",
    ["plugin", "install", "braid@braid"],
    copilotEnvironment,
  );
  await run(
    "copilot",
    ["plugin", "uninstall", "braid@braid"],
    copilotEnvironment,
  );
  await run(
    "copilot",
    ["plugin", "marketplace", "remove", "braid"],
    copilotEnvironment,
  );

  const geminiRoot = path.join(temporaryRoot, "gemini");
  await mkdir(path.join(geminiRoot, "home"), { recursive: true });
  const geminiEnvironment = {
    ...base,
    BRAID_NATIVE_SOURCE: root,
    HOME: path.join(geminiRoot, "home"),
    GEMINI_CLI_HOME: path.join(geminiRoot, "config"),
  };
  const geminiInstallProgram = `
set timeout 60
spawn gemini extensions install $env(BRAID_NATIVE_SOURCE) --consent --skip-settings
expect {
  -re {Do you trust.*continue} { send "y\\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
`;
  const geminiListProgram =
    "set timeout 60\nspawn gemini extensions list --output-format json\nexpect eof";
  await run("gemini", ["extensions", "validate", root], geminiEnvironment);
  const geminiInstall = await run(
    "expect",
    ["-c", geminiInstallProgram],
    geminiEnvironment,
  );
  assert(
    (geminiInstall.stdout + geminiInstall.stderr).includes(
      'Extension "braid" installed successfully',
    ),
    "Gemini install exited zero without reporting installation success",
  );
  const geminiList = await run(
    "expect",
    ["-c", geminiListProgram],
    geminiEnvironment,
  );
  assert(
    /"name"\s*:\s*"braid"/u.test(geminiList.stdout + geminiList.stderr),
    "Gemini did not discover the installed Braid extension",
  );
  await assertBraidSetup("gemini", geminiEnvironment);
  await run(
    "gemini",
    ["extensions", "disable", "braid", "--scope", "Workspace"],
    geminiEnvironment,
  );
  const disabledGemini = await run(
    "expect",
    ["-c", geminiListProgram],
    geminiEnvironment,
  );
  assert(
    /"isActive"\s*:\s*false/u.test(
      disabledGemini.stdout + disabledGemini.stderr,
    ),
    "Gemini workspace disable did not deactivate Braid",
  );
  await run(
    "gemini",
    ["extensions", "enable", "braid", "--scope", "Workspace"],
    geminiEnvironment,
  );
  const enabledGemini = await run(
    "expect",
    ["-c", geminiListProgram],
    geminiEnvironment,
  );
  assert(
    /"isActive"\s*:\s*true/u.test(enabledGemini.stdout + enabledGemini.stderr),
    "Gemini workspace enable did not reactivate Braid",
  );
  await run("gemini", ["extensions", "uninstall", "braid"], geminiEnvironment);
  await run("expect", ["-c", geminiInstallProgram], geminiEnvironment);
  await run("gemini", ["extensions", "uninstall", "braid"], geminiEnvironment);

  const settingsAfter = await Promise.all(realSettings.map(hashIfPresent));
  assert(
    JSON.stringify(settingsBefore) === JSON.stringify(settingsAfter),
    "A real user-level host settings file changed during isolated installation",
  );
  process.stdout.write(
    "Isolated Codex, Copilot, and Gemini install/update-or-toggle/uninstall/reinstall matrix passed.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true });
}
