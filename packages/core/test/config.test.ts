import { describe, expect, it } from "vitest";
import {
  configHash,
  DEFAULT_ARCHITECTURE_CONFIG,
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
