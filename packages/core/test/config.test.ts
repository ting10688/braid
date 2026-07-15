import { describe, expect, it } from "vitest";
import {
  configHash,
  DEFAULT_ARCHITECTURE_CONFIG,
  executionConfigHash,
  migrationConfigHash,
  parseArchitectureConfig,
} from "../src/index.js";

describe("architecture configuration", () => {
  it("validates the default configuration deterministically", () => {
    const first = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    const second = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    expect(first.project.language).toBe("typescript");
    expect(first.planner).toEqual({
      enabled_proposals: ["extract-module", "break-cycle"],
      max_proposals: 10,
      min_symbol_cluster_size: 2,
      preferred_max_affected_files: 10,
      include_high_risk: true,
    });
    expect(first.migration).toEqual({
      enabled: false,
      supportedProposalTypes: ["extract-module"],
      maximumChangedFiles: 8,
      codex: {
        executable: "codex",
        timeoutMs: 900_000,
        model: null,
        reasoningEffort: null,
        sandbox: "workspace-write",
      },
      validation: { commands: [] },
    });
    expect(configHash(first)).toBe(configHash(second));
  });

  it("adds planner defaults to an existing Phase 1 configuration", () => {
    const phaseOneConfig = DEFAULT_ARCHITECTURE_CONFIG.replace(
      /\nplanner:[\s\S]*$/u,
      "\n",
    );
    expect(parseArchitectureConfig(phaseOneConfig).planner.max_proposals).toBe(
      10,
    );
  });

  it("adds disabled migration defaults to existing configurations", () => {
    const legacy = DEFAULT_ARCHITECTURE_CONFIG.replace(
      /\nmigration:[\s\S]*$/u,
      "\n",
    );
    const legacyConfig = parseArchitectureConfig(legacy);
    const currentConfig = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    expect(legacyConfig.migration).toMatchObject({
      enabled: false,
      maximumChangedFiles: 8,
      validation: { commands: [] },
    });
    expect(configHash(legacyConfig)).toBe(configHash(currentConfig));

    const changedMigration = {
      ...currentConfig,
      migration: { ...currentConfig.migration, maximumChangedFiles: 4 },
    };
    expect(configHash(changedMigration)).toBe(configHash(currentConfig));
    expect(migrationConfigHash(changedMigration)).not.toBe(
      migrationConfigHash(currentConfig),
    );
    expect(executionConfigHash(changedMigration)).not.toBe(
      executionConfigHash(currentConfig),
    );
  });

  it("rejects shell command strings and unsafe migration executables", () => {
    const shellCommand = DEFAULT_ARCHITECTURE_CONFIG.replace(
      "    commands: []",
      "    commands:\n      - id: unsafe\n        executable: sh -c\n        arguments: []",
    );
    expect(() => parseArchitectureConfig(shellCommand)).toThrow(
      /migration\.validation\.commands\.0\.executable/u,
    );
  });

  it("reports the invalid field path", () => {
    const invalid = DEFAULT_ARCHITECTURE_CONFIG.replace(
      "oversized_file_lines: 500",
      "oversized_file_lines: no",
    );
    expect(() => parseArchitectureConfig(invalid)).toThrow(
      /thresholds\.oversized_file_lines/u,
    );
  });

  it("reports invalid planner values with their field path", () => {
    const invalid = DEFAULT_ARCHITECTURE_CONFIG.replace(
      "    - break-cycle",
      "    - rewrite-everything",
    );
    expect(() => parseArchitectureConfig(invalid)).toThrow(
      /planner\.enabled_proposals\.1/u,
    );
  });
});
