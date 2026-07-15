import { z } from "zod";

export const migrationStatusSchema = z.enum([
  "proposed",
  "approved",
  "running",
  "validated",
  "failed",
  "rolled-back",
]);

export const migrationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  type: z.enum([
    "extract-module",
    "break-cycle",
    "move-symbols",
    "introduce-boundary",
  ]),
  parentSnapshotId: z.string().min(1),
  status: migrationStatusSchema,
  affectedFiles: z.array(z.string()),
  dependencies: z.array(z.string()),
  featureDependencies: z.array(z.string()),
});

export type MigrationStatus = z.infer<typeof migrationStatusSchema>;
export type Migration = z.infer<typeof migrationSchema>;
