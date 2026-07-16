import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "docs", "assets", "brand");
const specification = JSON.parse(
  await readFile(path.join(brand, "asset-spec.json"), "utf8"),
);
const sourcePath = path.join(brand, specification.source.file);
const source = await readFile(sourcePath);
const sourceHash = createHash("sha256").update(source).digest("hex");
if (sourceHash !== specification.source.sha256)
  throw new Error(`Source logo hash mismatch: ${sourceHash}`);

const sourceMetadata = await sharp(source).metadata();
if (
  sourceMetadata.width !== specification.source.width ||
  sourceMetadata.height !== specification.source.height ||
  sourceMetadata.format !== specification.source.format ||
  sourceMetadata.hasAlpha !== specification.source.alpha
)
  throw new Error("Source logo metadata does not match asset-spec.json");

for (const [filename, expected] of Object.entries(specification.outputs)) {
  const filePath = path.join(brand, filename);
  await access(filePath);
  const [metadata, file] = await Promise.all([
    sharp(filePath).metadata(),
    stat(filePath),
  ]);
  if (metadata.format !== "png") throw new Error(`${filename} is not PNG`);
  if (metadata.width !== expected.width || metadata.height !== expected.height)
    throw new Error(`${filename} has unexpected dimensions`);
  if (file.size > expected.maxBytes)
    throw new Error(`${filename} exceeds ${expected.maxBytes} bytes`);
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const match of readme.matchAll(/<img[^>]+src="([^"]+)"/gu)) {
  const relative = match[1];
  if (/^(?:https?:|\/)/u.test(relative)) continue;
  await access(path.resolve(root, relative));
}

process.stdout.write(
  `Verified approved source and ${Object.keys(specification.outputs).length} generated brand assets.\n`,
);
