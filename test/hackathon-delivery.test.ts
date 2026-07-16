import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "docs", "assets", "brand");

describe("hackathon delivery contracts", () => {
  it("keeps the approved source hash and structural image dimensions", async () => {
    const specification = JSON.parse(
      await readFile(path.join(brand, "asset-spec.json"), "utf8"),
    );
    const source = await readFile(path.join(brand, specification.source.file));
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      specification.source.sha256,
    );

    for (const [fileName, output] of Object.entries<{
      width: number;
      height: number;
    }>(specification.outputs)) {
      const file = path.join(brand, fileName);
      const metadata = await sharp(file).metadata();
      expect(metadata.format).toBe("png");
      expect([metadata.width, metadata.height]).toEqual([
        output.width,
        output.height,
      ]);
      await access(file);
    }
  });

  it("uses a valid repository-relative README logo", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    const source = /<img src="([^"]*braid-logo-readme\.png)"/.exec(readme)?.[1];
    expect(source).toBe("docs/assets/brand/braid-logo-readme.png");
    await access(path.join(root, source!));
  });

  it("drives the demo through real CLI JSON instead of a hard-coded guard report", async () => {
    const runner = await readFile(
      path.join(root, "demo", "growth-mode-live-guard", "run-demo.mjs"),
      "utf8",
    );
    expect(runner).toContain("const runBraid = async");
    expect(runner).toContain("return JSON.parse(output)");
    expect(runner).toContain('"growth",\n    "check"');
    expect(runner).toContain('finding.ruleId === "new-cycle"');
    expect(runner).not.toMatch(
      /const (blocked|repaired) = \{\s*["']status["']/,
    );
  });

  it("keeps clean-room verification and CI artifact publication wired", async () => {
    const verifier = await readFile(
      path.join(root, "scripts", "verify-distribution.mjs"),
      "utf8",
    );
    const workflow = await readFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(verifier).toContain('NODE_PATH: ""');
    expect(verifier).toContain('"--version"');
    expect(verifier).toContain('"--help"');
    expect(verifier).toContain('"--keep"');
    expect(verifier).toContain("tar.gz logical contents differ");
    expect(workflow).toContain("pnpm brand:render");
    expect(workflow).toContain("pnpm distribution:verify");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });
});
