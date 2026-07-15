import { createHash } from "node:crypto";
import type {
  ArchitectureConfig,
  ArchitectureSnapshot,
  ProposalTarget,
  ProposalType,
} from "@braid/core";

export const PLANNER_VERSION = "0.2.1";

const normalizedJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map(normalizedJson).sort().join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalizedJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const snapshotContent = (snapshot: ArchitectureSnapshot): unknown => {
  const { language, files, modules, imports, cycles, publicEntrypoints } =
    snapshot.repository;
  return {
    configHash: snapshot.configHash,
    gitCommit: snapshot.gitCommit,
    repository: {
      language,
      files,
      modules,
      imports,
      cycles,
      publicEntrypoints,
    },
    metrics: snapshot.metrics,
  };
};

export const createProposalId = (
  snapshot: ArchitectureSnapshot,
  config: ArchitectureConfig,
  type: ProposalType,
  target: ProposalTarget,
  affectedFiles: readonly string[],
  affectedModules: readonly string[],
): string => {
  const prefix = type === "extract-module" ? "EM" : "BC";
  const { migration: _migration, ...analysisAndPlannerConfig } = config;
  void _migration;
  const hash = createHash("sha256")
    .update(
      normalizedJson({
        schemaVersion: 1,
        plannerVersion: PLANNER_VERSION,
        snapshot: snapshotContent(snapshot),
        config: analysisAndPlannerConfig,
        type,
        target,
        affectedFiles: [...affectedFiles].sort(),
        affectedModules: [...affectedModules].sort(),
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return `P-${prefix}-${hash}`;
};
