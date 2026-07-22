#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;
const productionTimeoutMs = 30_000;
const requestedTestTimeout = Number(
  process.env.NODE_ENV === "test"
    ? process.env.BRAID_NATIVE_TEST_TIMEOUT_MS
    : Number.NaN,
);
const TIMEOUT_MS =
  Number.isInteger(requestedTestTimeout) &&
  requestedTestTimeout >= 50 &&
  requestedTestTimeout <= productionTimeoutMs
    ? requestedTestTimeout
    : productionTimeoutMs;
const hosts = new Set(["codex", "claude", "gemini", "copilot"]);
const events = {
  codex: new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]),
  claude: new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]),
  gemini: new Set(["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"]),
  copilot: new Set([
    "sessionStart",
    "userPromptSubmitted",
    "postToolUse",
    "agentStop",
  ]),
};

const [host, event] = process.argv.slice(2);

const failOpen = () => {
  if (host === "codex") {
    return {
      continue: true,
      systemMessage:
        "Braid Growth Guard could not run; continuing without a pass result. Run `braid growth status`.",
    };
  }
  return host === "copilot" && event === "agentStop"
    ? { decision: "allow" }
    : {};
};

const diagnose = (message) => {
  process.stderr.write(`[braid-native] ${message}\n`);
};

const finish = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const readPayload = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BYTES) throw new Error("stdin exceeds 1 MiB");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  JSON.parse(raw);
  return raw;
};

const executableNames =
  process.platform === "win32"
    ? ["braid.cmd", "braid.exe", "braid"]
    : ["braid"];

const findBraid = async () => {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of executableNames) {
      const candidate = path.resolve(directory, name);
      try {
        const info = await stat(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  throw new Error("braid is not on PATH");
};

const runBraid = async (executable, payload) =>
  await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["growth", "hook", "--host", host, "--event", event],
      {
        env: { ...process.env, BRAID_NATIVE_ADAPTER: host },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const terminate = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 250).unref();
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) terminate();
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_BYTES) terminate();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("braid hook timed out"));
      else if (stdoutBytes > MAX_BYTES || stderrBytes > MAX_BYTES)
        reject(new Error("braid hook output exceeds 1 MiB"));
      else if (code !== 0) reject(new Error("braid hook exited nonzero"));
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(payload);
  });

try {
  if (!host || !hosts.has(host) || !event || !events[host].has(event)) {
    throw new Error("unsupported host or event");
  }
  const payload = await readPayload();
  const output = await runBraid(await findBraid(), payload);
  finish(JSON.parse(output));
} catch (error) {
  diagnose(error instanceof Error ? error.message : "adapter failure");
  finish(failOpen());
}
