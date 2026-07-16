import { describe, expect, it } from "vitest";
import {
  configHash,
  DEFAULT_ARCHITECTURE_CONFIG,
  executionConfigHash,
  growthModeConfigHash,
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
      maximumSymbols: 20,
      codex: {
        executable: "codex",
        timeoutMs: 900_000,
        model: null,
        reasoningEffort: null,
        sandbox: "workspace-write",
      },
      validation: { commands: [] },
    });
    expect(first.growthMode).toEqual({
      enabled: false,
      enforcement: "block",
      blockOn: ["new-cycle"],
      warnOn: ["oversized-threshold-crossed", "oversized-module-growth"],
      maxFindings: 5,
      maxFeedbackCharacters: 4_000,
      stopBlocksPerFingerprint: 1,
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
      maximumSymbols: 20,
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

    const { maximumSymbols: _maximumSymbols, ...legacyMigration } =
      currentConfig.migration;
    void _maximumSymbols;
    expect(
      migrationConfigHash({
        ...currentConfig,
        migration: legacyMigration,
      } as typeof currentConfig),
    ).toBe(migrationConfigHash(currentConfig));
    const changedSymbolBudget = {
      ...currentConfig,
      migration: { ...currentConfig.migration, maximumSymbols: 10 },
    };
    expect(migrationConfigHash(changedSymbolBudget)).not.toBe(
      migrationConfigHash(currentConfig),
    );
  });

  it("keeps Growth Mode absent by default without changing proposal or migration identities", () => {
    const current = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    const legacy = parseArchitectureConfig(
      DEFAULT_ARCHITECTURE_CONFIG.replace(/\ngrowthMode:[\s\S]*$/u, "\n"),
    );
    expect(legacy.growthMode.enabled).toBe(false);
    expect(growthModeConfigHash(legacy)).toBe(growthModeConfigHash(current));

    const enabled = parseArchitectureConfig(
      DEFAULT_ARCHITECTURE_CONFIG.replace(
        "growthMode:\n  enabled: false",
        "growthMode:\n  enabled: true",
      ),
    );
    expect(configHash(enabled)).toBe(configHash(current));
    expect(executionConfigHash(enabled)).toBe(executionConfigHash(current));
    expect(growthModeConfigHash(enabled)).not.toBe(
      growthModeConfigHash(current),
    );
  });

  it("enables bounded Growth Mode defaults only when its section is explicit", () => {
    const explicit = parseArchitectureConfig(
      DEFAULT_ARCHITECTURE_CONFIG.replace(
        /growthMode:[\s\S]*$/u,
        "growthMode: {}\n",
      ),
    );
    expect(explicit.growthMode).toMatchObject({
      enabled: true,
      enforcement: "block",
      blockOn: ["new-cycle"],
      maxFindings: 5,
      stopBlocksPerFingerprint: 1,
    });
  });

  it("rejects unbounded or unknown Growth Mode policy values", () => {
    const invalid = DEFAULT_ARCHITECTURE_CONFIG.replace(
      "  maxFeedbackCharacters: 4000",
      "  maxFeedbackCharacters: 10",
    );
    expect(() => parseArchitectureConfig(invalid)).toThrow(
      /growthMode\.maxFeedbackCharacters/u,
    );
  });

  it("hashes Growth Mode configuration independently of Unicode key insertion order", () => {
    const config = parseArchitectureConfig(DEFAULT_ARCHITECTURE_CONFIG);
    const first = {
      ...config,
      modules: { "z-module": {}, "ä-module": {} },
    };
    const second = {
      ...config,
      modules: { "ä-module": {}, "z-module": {} },
    };
    expect(growthModeConfigHash(first)).toBe(growthModeConfigHash(second));
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
