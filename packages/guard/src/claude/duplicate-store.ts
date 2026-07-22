import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 } from "../canonical.js";
import { resolveGitContext } from "../git-state.js";

export type ClaudeHookSource = "native-plugin" | "manual";
export type ClaudeCoordinatedEvent =
  "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

export type ClaudeAdapterPreflight =
  { action: "evaluate" } | { action: "defer" } | { action: "duplicate" };

export interface ClaudeDuplicateCoordinator {
  preflight(
    source: ClaudeHookSource,
    event: ClaudeCoordinatedEvent,
  ): Promise<ClaudeAdapterPreflight>;
  claim(
    source: ClaudeHookSource,
    event: ClaudeCoordinatedEvent,
    fingerprint: string,
  ): Promise<boolean>;
}

const isAlreadyPresent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export class ClaudeDuplicateStore implements ClaudeDuplicateCoordinator {
  readonly directory: string;
  readonly nativeMarkerPath: string;

  constructor(
    public readonly gitDirectory: string,
    sessionId: string,
    private readonly worktreeId: string,
  ) {
    // Hashing keeps provider session identifiers out of filenames and state.
    const sessionKey = sha256({ sessionId, worktreeId });
    this.directory = path.join(
      gitDirectory,
      "braid",
      "growth-mode",
      "v1",
      "claude-adapters",
      sessionKey,
    );
    this.nativeMarkerPath = path.join(this.directory, "native-plugin.json");
  }

  claimPath(event: ClaudeCoordinatedEvent, fingerprint: string): string {
    return path.join(
      this.directory,
      "claims",
      `${sha256({ event, fingerprint, worktreeId: this.worktreeId })}.json`,
    );
  }

  private async nativeActive(): Promise<boolean> {
    try {
      await readFile(this.nativeMarkerPath, "utf8");
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async markNativeActive(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(
        this.nativeMarkerPath,
        `${canonicalJson({ schemaVersion: 1, source: "native-plugin", worktreeId: this.worktreeId })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    }
  }

  async preflight(
    source: ClaudeHookSource,
    event: ClaudeCoordinatedEvent,
  ): Promise<ClaudeAdapterPreflight> {
    if (source === "native-plugin") {
      await this.markNativeActive();
      return { action: "evaluate" };
    }
    if (await this.nativeActive()) return { action: "duplicate" };
    // Manual SessionStart defers baseline work until UserPromptSubmit so a
    // native SessionStart in the same lifecycle always becomes authoritative.
    return event === "SessionStart"
      ? { action: "defer" }
      : { action: "evaluate" };
  }

  async claim(
    source: ClaudeHookSource,
    event: ClaudeCoordinatedEvent,
    fingerprint: string,
  ): Promise<boolean> {
    const claimPath = this.claimPath(event, fingerprint);
    await mkdir(path.dirname(claimPath), { recursive: true });
    try {
      await writeFile(
        claimPath,
        `${canonicalJson({ schemaVersion: 1, event, source, worktreeId: this.worktreeId })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      return true;
    } catch (error) {
      if (isAlreadyPresent(error)) return false;
      throw error;
    }
  }
}

export const createClaudeDuplicateCoordinator = async (
  projectRoot: string,
  sessionId: string,
): Promise<ClaudeDuplicateCoordinator> => {
  const context = await resolveGitContext(projectRoot);
  return new ClaudeDuplicateStore(
    context.gitDirectory,
    sessionId,
    context.repository.worktreeId,
  );
};
