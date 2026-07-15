import type {
  CodexMigrationSummary,
  MigrationExecutionPlan,
} from "@braid/core";

export interface ExecutorEnvironment {
  kind: "codex" | "scripted-test";
  executableVersion?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox: "workspace-write";
}

export interface ExecutorContext {
  worktreePath: string;
  prompt: string;
  timeoutMs: number;
}

export interface ExecutorEvent {
  type: "command" | "file-change" | "message" | "usage";
  timestamp?: string;
  command?: string[];
  path?: string;
  message?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  };
}

export interface ExecutorResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  events: ExecutorEvent[];
  summary?: CodexMigrationSummary;
}

export interface MigrationExecutor {
  readonly kind: "codex" | "scripted-test";
  inspect(): Promise<ExecutorEnvironment>;
  execute(
    plan: MigrationExecutionPlan,
    context: ExecutorContext,
  ): Promise<ExecutorResult>;
}
