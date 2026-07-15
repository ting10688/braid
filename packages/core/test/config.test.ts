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
    expect(configHash(first)).toBe(configHash(second));
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
});
