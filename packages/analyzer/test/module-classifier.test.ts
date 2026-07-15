import { describe, expect, it } from "vitest";
import { classifyModule } from "../src/index.js";

describe("module classification", () => {
  it.each([
    ["src/modules/users/service.ts", "modules/users"],
    ["src/services/user-service.ts", "services"],
    ["src/index.ts", "root"],
    ["packages/api/src/routes/health.ts", "routes"],
  ])("classifies %s", (filePath, expected) => {
    expect(classifyModule(filePath)).toBe(expected);
  });
});
