import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ArchitectureMetrics,
  GrowthModeFinding,
  GrowthModeReport,
  RepositoryModel,
} from "@braid/core";

export const binaryCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const canonicalUnorderedJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value
      .map((item) => canonicalUnorderedJson(item))
      .sort(binaryCompare)
      .join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalUnorderedJson(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");

export const prefixedId = <Prefix extends "GB" | "GF" | "GR">(
  prefix: Prefix,
  value: unknown,
): `${Prefix}-${string}` => `${prefix}-${sha256(value).slice(0, 12)}`;

export const repositoryArchitectureFingerprint = (
  repository: RepositoryModel,
  metrics: ArchitectureMetrics,
  warnings: readonly string[],
): string =>
  sha256(
    canonicalUnorderedJson({
      repository: { ...repository, projectRoot: "." },
      metrics,
      warnings,
    }),
  );

export const portableRepository = (
  repository: RepositoryModel,
): RepositoryModel => ({ ...repository, projectRoot: "." });

export const portablePath = (value: string): string => {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//u, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:\//u.test(normalized)
  )
    throw new Error(`Expected a repository-relative path, received ${value}`);
  return normalized;
};

export const canonicalFinding = (
  finding: Omit<GrowthModeFinding, "id">,
): GrowthModeFinding => {
  const content = {
    ...finding,
    files: [...new Set(finding.files.map(portablePath))].sort(),
    symbols: [...new Set(finding.symbols)].sort(),
    edges: [...finding.edges].sort((left, right) =>
      binaryCompare(
        `${left.fromFile}\0${left.toFile}\0${left.fromModule}\0${left.toModule}\0${left.typeOnly}`,
        `${right.fromFile}\0${right.toFile}\0${right.fromModule}\0${right.toModule}\0${right.typeOnly}`,
      ),
    ),
    baselineEvidence: [...finding.baselineEvidence].sort(),
    currentEvidence: [...finding.currentEvidence].sort(),
    suggestions: [...finding.suggestions],
  };
  return { id: prefixedId("GF", content), ...content };
};

export const reportSemanticContent = (
  report: Omit<GrowthModeReport, "id"> | GrowthModeReport,
): unknown => {
  const {
    id: _id,
    generatedAt: _generatedAt,
    cacheHit: _cacheHit,
    statistics: _statistics,
    ...semantic
  } = report as GrowthModeReport;
  void _id;
  void _generatedAt;
  void _cacheHit;
  void _statistics;
  return semantic;
};

export const reportId = (
  report: Omit<GrowthModeReport, "id">,
): `GR-${string}` => prefixedId("GR", reportSemanticContent(report));
