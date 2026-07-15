import { createHash } from "node:crypto";
import { z } from "zod";
import {
  architectureMetricsSchema,
  type ArchitectureMetrics,
} from "./architecture-metrics.js";
import {
  repositoryModelSchema,
  type RepositoryModel,
} from "./repository-model.js";

export const architectureSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^S-[a-f0-9]{12}-\d{8}T\d{9}Z$/),
  projectRoot: z.string().min(1),
  createdAt: z.string().datetime(),
  gitCommit: z.string().min(1).nullable(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  repository: repositoryModelSchema,
  metrics: architectureMetricsSchema,
});

export type ArchitectureSnapshot = z.infer<typeof architectureSnapshotSchema>;

export interface CreateSnapshotInput {
  projectRoot: string;
  gitCommit: string | null;
  configHash: string;
  repository: RepositoryModel;
  metrics: ArchitectureMetrics;
  createdAt?: Date;
}

export const createArchitectureSnapshot = (
  input: CreateSnapshotInput,
): ArchitectureSnapshot => {
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        configHash: input.configHash,
        gitCommit: input.gitCommit,
        repository: input.repository,
        metrics: input.metrics,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  const timestamp = createdAt.replaceAll(/[-:.]/g, "");

  return architectureSnapshotSchema.parse({
    schemaVersion: 1,
    id: `S-${contentHash}-${timestamp}`,
    projectRoot: input.projectRoot,
    createdAt,
    gitCommit: input.gitCommit,
    configHash: input.configHash,
    repository: input.repository,
    metrics: input.metrics,
  });
};
