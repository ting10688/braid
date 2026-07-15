import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { ZodError } from "zod";
import { InvalidInputError } from "@braid/shared";
import {
  architectureConfigSchema,
  type ArchitectureConfig,
} from "./architecture-config.js";

const normalizedJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalizedJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const hashNormalized = (value: unknown): string =>
  createHash("sha256").update(normalizedJson(value)).digest("hex");

export const configHash = (config: ArchitectureConfig): string => {
  const { migration: _migration, ...analysisAndPlannerConfig } = config;
  void _migration;
  return hashNormalized(analysisAndPlannerConfig);
};

export const migrationConfigHash = (config: ArchitectureConfig): string => {
  const { maximumSymbols, ...legacyCompatible } = config.migration;
  return hashNormalized(
    maximumSymbols === 20 ? legacyCompatible : config.migration,
  );
};

export const executionConfigHash = (config: ArchitectureConfig): string =>
  hashNormalized({
    analysisAndPlanner: configHash(config),
    migration: migrationConfigHash(config),
  });

export const parseArchitectureConfig = (
  contents: string,
): ArchitectureConfig => {
  try {
    return architectureConfigSchema.parse(parse(contents));
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new InvalidInputError(`Invalid Braid configuration: ${details}`, {
        cause: error,
      });
    }
    throw new InvalidInputError(
      `Invalid Braid configuration YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const loadArchitectureConfig = async (
  filePath: string,
): Promise<ArchitectureConfig> => {
  try {
    return parseArchitectureConfig(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof InvalidInputError) throw error;
    throw new InvalidInputError(
      `Cannot read Braid configuration at ${filePath}`,
      { cause: error },
    );
  }
};
