#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEFAULT_ARCHITECTURE_CONFIG } from "../packages/core/dist/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "adapters", "native-agent", "runtime.mjs");
const braidCli = path.join(root, "apps", "cli", "dist", "index.js");
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "braid-native-lifecycle-"),
);
const repository = path.join(temporaryRoot, "repository");
const linkedWorktree = path.join(temporaryRoot, "linked-worktree");
const bin = path.join(temporaryRoot, "bin");
const launcher = path.join(bin, "braid");
const enabledConfig = DEFAULT_ARCHITECTURE_CONFIG.replace(
  "growthMode:\n  enabled: false",
  "growthMode:\n  enabled: true",
);
const originalSource = "export const a = 1;\n";
const cycleSource = 'import { b } from "../b/index.js";\nexport const a = b;\n';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const git = async (cwd, ...arguments_) =>
  (
    await execFileAsync("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
    })
  ).stdout.trim();

const eventNames = {
  codex: {
    session: "SessionStart",
    prompt: "UserPromptSubmit",
    post: "PostToolUse",
    final: "Stop",
  },
  gemini: {
    session: "SessionStart",
    prompt: "BeforeAgent",
    post: "AfterTool",
    final: "AfterAgent",
  },
  copilot: {
    session: "sessionStart",
    prompt: "userPromptSubmitted",
    post: "postToolUse",
    final: "agentStop",
  },
};

const payload = (host, event, sessionId, cwd) => {
  if (host === "codex") {
    const common = {
      session_id: sessionId,
      transcript_path: null,
      cwd,
      model: "<model>",
      permission_mode: "default",
      hook_event_name: event,
    };
    if (event === "SessionStart") return { ...common, source: "startup" };
    if (event === "UserPromptSubmit") {
      return { ...common, turn_id: "<turn-id>", prompt: "<redacted>" };
    }
    if (event === "PostToolUse") {
      return {
        ...common,
        turn_id: "<turn-id>",
        tool_name: "Write",
        tool_use_id: "<tool-id>",
        tool_input: { redacted: true },
        tool_response: { redacted: true },
      };
    }
    return {
      ...common,
      turn_id: "<turn-id>",
      stop_hook_active: false,
      last_assistant_message: null,
    };
  }
  if (host === "gemini") {
    const common = {
      session_id: sessionId,
      transcript_path: "<transcript-path>",
      cwd,
      timestamp: "2026-07-18T00:00:00.000Z",
      hook_event_name: event,
    };
    if (event === "SessionStart") return { ...common, source: "startup" };
    if (event === "BeforeAgent") return { ...common, prompt: "<redacted>" };
    if (event === "AfterTool") {
      return {
        ...common,
        tool_name: "write_file",
        tool_input: { redacted: true },
        tool_response: { redacted: true },
      };
    }
    return {
      ...common,
      prompt: "<redacted>",
      prompt_response: "<redacted>",
      stop_hook_active: false,
    };
  }
  const common = { sessionId, timestamp: 0, cwd };
  if (event === "sessionStart") {
    return { ...common, source: "new", initialPrompt: "<redacted>" };
  }
  if (event === "userPromptSubmitted") {
    return { ...common, prompt: "<redacted>" };
  }
  if (event === "postToolUse") {
    return {
      ...common,
      toolName: "bash",
      toolArgs: { redacted: true },
      toolResult: { resultType: "success", textResultForLlm: "<redacted>" },
    };
  }
  return {
    ...common,
    transcriptPath: "<transcript-path>",
    stopReason: "end_turn",
  };
};

const invoke = async (host, event, sessionId, cwd) =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, host, event], {
      cwd,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`${host}:${event} exited ${code}`));
      else if (diagnostic.includes("<redacted>")) {
        reject(
          new Error(`${host}:${event} leaked payload data to diagnostics`),
        );
      } else {
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch {
          reject(new Error(`${host}:${event} did not emit one JSON value`));
        }
      }
    });
    child.stdin.end(JSON.stringify(payload(host, event, sessionId, cwd)));
  });

const assertBlock = (host, output) => {
  if (host === "gemini")
    assert(output.decision === "deny", "Gemini did not deny final completion");
  else
    assert(
      output.decision === "block",
      `${host} did not block final completion`,
    );
};

const assertAllow = (host, output) => {
  if (host === "copilot")
    assert(output.decision === "allow", "Copilot did not allow completion");
  else if (host === "gemini") {
    assert(
      output.decision === "allow" || Object.keys(output).length === 0,
      "Gemini did not allow completion",
    );
  } else {
    assert(output.continue === true, "Codex did not allow completion");
  }
};

const scenario = async (project, host, label) => {
  const events = eventNames[host];
  const sessionId = `<${host}-${label}-session>`;
  const source = path.join(project, "src", "a", "index.ts");
  const headBefore = await git(project, "rev-parse", "HEAD");
  const indexBefore = await git(project, "ls-files", "--stage");
  const worktreesBefore = await git(project, "worktree", "list", "--porcelain");

  const started = await invoke(host, events.session, sessionId, project);
  assert(
    JSON.stringify(started).includes("additionalContext"),
    `${host} did not return baseline context`,
  );
  const prompted = await invoke(host, events.prompt, sessionId, project);
  if (host === "copilot")
    assert(
      Object.keys(prompted).length === 0,
      "Copilot prompt stdout must stay empty",
    );

  const note = path.join(project, "notes.md");
  await writeFile(note, "not architecture source\n");
  assertAllow(host, await invoke(host, events.final, sessionId, project));
  await rm(note);

  await writeFile(source, cycleSource);
  const checked = await invoke(host, events.post, sessionId, project);
  assert(
    JSON.stringify(checked).includes("additionalContext"),
    `${host} post-mutation feedback was absent`,
  );
  assertBlock(host, await invoke(host, events.final, sessionId, project));
  assertAllow(host, await invoke(host, events.final, sessionId, project));

  await writeFile(source, originalSource);
  assertAllow(host, await invoke(host, events.final, sessionId, project));
  assert(
    (await readFile(source, "utf8")) === originalSource,
    `${host} changed application source`,
  );
  assert(
    (await git(project, "rev-parse", "HEAD")) === headBefore,
    `${host} changed HEAD`,
  );
  assert(
    (await git(project, "ls-files", "--stage")) === indexBefore,
    `${host} changed the index`,
  );
  assert(
    (await git(project, "worktree", "list", "--porcelain")) === worktreesBefore,
    `${host} changed Git worktree registration`,
  );
  assert(
    (await git(project, "status", "--porcelain=v1")) === "",
    `${host} left a working-tree change`,
  );
};

try {
  await mkdir(bin, { recursive: true });
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(braidCli)} "$@"\n`,
  );
  await chmod(launcher, 0o755);
  await Promise.all([
    mkdir(path.join(repository, ".braid"), { recursive: true }),
    mkdir(path.join(repository, "src", "a"), { recursive: true }),
    mkdir(path.join(repository, "src", "b"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(repository, ".braid", "architecture.yaml"),
      enabledConfig,
    ),
    writeFile(
      path.join(repository, "package.json"),
      '{"name":"native-lifecycle"}\n',
    ),
    writeFile(path.join(repository, "src", "a", "index.ts"), originalSource),
    writeFile(
      path.join(repository, "src", "b", "index.ts"),
      'import { a } from "../a/index.js";\nexport const b = a;\n',
    ),
  ]);
  await execFileAsync("git", ["init", "--quiet", repository]);
  await git(repository, "config", "user.email", "native@example.test");
  await git(repository, "config", "user.name", "Native Adapter Test");
  await git(repository, "add", ".");
  await git(repository, "commit", "--quiet", "-m", "fixture");

  for (const host of Object.keys(eventNames))
    await scenario(repository, host, "checkout");

  await git(
    repository,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "native-linked",
    linkedWorktree,
  );
  for (const host of Object.keys(eventNames))
    await scenario(linkedWorktree, host, "worktree");
  await git(repository, "worktree", "remove", "--force", linkedWorktree);

  process.stdout.write(
    "Native adapter checkout/worktree baseline, mutation, block, bounded retry, repair, and pass tests passed.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true });
}
