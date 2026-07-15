import {
  migrationExecutionPlanSchema,
  type MigrationExecutionPlan,
} from "@braid/core";
import type {
  ExecutorContext,
  ExecutorEnvironment,
  ExecutorResult,
  MigrationExecutor,
} from "./executor.js";

export type ScriptedExecution = (
  plan: MigrationExecutionPlan,
  context: ExecutorContext,
) => ExecutorResult | Promise<ExecutorResult>;

export class ScriptedTestExecutor implements MigrationExecutor {
  readonly kind = "scripted-test" as const;

  constructor(readonly executeScript: ScriptedExecution) {}

  async inspect(): Promise<ExecutorEnvironment> {
    return { kind: "scripted-test", sandbox: "workspace-write" };
  }

  async execute(
    unparsedPlan: MigrationExecutionPlan,
    context: ExecutorContext,
  ): Promise<ExecutorResult> {
    const plan = migrationExecutionPlanSchema.parse(unparsedPlan);
    if (plan.executor.kind !== "scripted-test")
      throw new Error(
        "ScriptedTestExecutor requires a scripted-test execution plan",
      );
    return this.executeScript(plan, context);
  }
}
