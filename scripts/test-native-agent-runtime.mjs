#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "adapters", "native-agent", "runtime.mjs");
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "braid-native-runtime-"),
);
const bin = path.join(temporaryRoot, "bin");
const mock = path.join(bin, "braid");
const pidFile = path.join(temporaryRoot, "pid");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async (host, event, payload, mode, timeout = 15_000) =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, host, event], {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_ENV: "test",
        BRAID_NATIVE_TEST_TIMEOUT_MS: mode === "timeout" ? "100" : "10000",
        MOCK_BRAID_MODE: mode,
        MOCK_BRAID_PID: pidFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Runtime test did not finish"));
    }, timeout);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });

try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(
    mock,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const mode = process.env.MOCK_BRAID_MODE;
if (mode === "nonzero") process.exit(7);
if (mode === "malformed") { process.stdout.write("not-json\\n"); process.exit(0); }
if (mode === "timeout") {
  await writeFile(process.env.MOCK_BRAID_PID, String(process.pid));
  await new Promise(() => {});
}
process.stdout.write(mode === "block" ? '{"decision":"block","reason":"repair"}\\n' : '{}\\n');
`,
  );
  await chmod(mock, 0o755);

  const payload = {
    sessionId: "<session-id>",
    timestamp: 0,
    cwd: "<repo-root>",
    transcriptPath: "<transcript-path>",
    stopReason: "end_turn",
  };
  const valid = await run("copilot", "agentStop", payload, "block");
  assert(valid.code === 0, "Runtime block translation exited nonzero");
  assert(
    JSON.stringify(JSON.parse(valid.stdout)) ===
      JSON.stringify({ decision: "block", reason: "repair" }),
    "Runtime did not forward one valid hook JSON response",
  );

  for (const mode of ["malformed", "nonzero", "timeout"]) {
    const result = await run("copilot", "agentStop", payload, mode);
    assert(result.code === 0, `${mode} adapter failure did not fail open`);
    assert(
      JSON.stringify(JSON.parse(result.stdout)) ===
        JSON.stringify({ decision: "allow" }),
      `${mode} adapter failure returned the wrong fail-open output`,
    );
    assert(
      !result.stderr.includes("<session-id>"),
      `${mode} diagnostics leaked payload data`,
    );
  }

  const childPid = Number(await readFile(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    childAlive = false;
  }
  assert(!childAlive, "Timed-out Braid child process remained alive");

  const withoutBraid = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [runtime, "gemini", "AfterAgent"],
      { env: { ...process.env, PATH: temporaryRoot }, timeout: 5_000 },
      (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
    ).stdin?.end(
      JSON.stringify({
        session_id: "<session-id>",
        transcript_path: "<transcript-path>",
        cwd: "<repo-root>",
        timestamp: "2026-07-18T00:00:00.000Z",
        hook_event_name: "AfterAgent",
        prompt: "<redacted>",
        prompt_response: "<redacted>",
        stop_hook_active: false,
      }),
    );
  });
  assert(
    JSON.stringify(JSON.parse(withoutBraid.stdout)) === "{}",
    "Missing Braid did not fail open",
  );
  assert(
    !withoutBraid.stderr.includes("<redacted>"),
    "Missing-Braid diagnostics leaked payload data",
  );

  process.stdout.write(
    "Native adapter runtime and process cleanup tests passed.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true });
}
