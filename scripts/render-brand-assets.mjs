import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "docs", "assets", "brand");
const sourcePath = path.join(brand, "braid-logo-source.jpeg");
const expectedSourceHash =
  "c816d7594d2c8c95257f2ed568904e8eba1ec57630fd5cc04f41771a31623142";
const palette = {
  charcoal: "#11161C",
  offWhite: "#F3F2EF",
  mint: "#8EE7BF",
};

const source = await readFile(sourcePath);
const sourceHash = createHash("sha256").update(source).digest("hex");
if (sourceHash !== expectedSourceHash)
  throw new Error(`Approved source logo hash mismatch: ${sourceHash}`);

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const textSvg = (width, height, elements) =>
  Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .wordmark { font-weight: 700; letter-spacing: -0.035em; }
    .tagline { font-weight: 520; letter-spacing: -0.018em; }
    .support { font-weight: 600; letter-spacing: 0.08em; }
  </style>
  ${elements
    .map(
      ({ x, y, size, fill, className, text, anchor = "start" }) =>
        `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" class="${className}" text-anchor="${anchor}">${escapeXml(text)}</text>`,
    )
    .join("\n  ")}
</svg>`);

const resizedLogo = async (size) =>
  sharp(source)
    .resize(size, size, { fit: "contain" })
    .jpeg({ quality: 100 })
    .toBuffer();

const writeLogo = async (filename, size) =>
  sharp(source)
    .resize(size, size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toFile(path.join(brand, filename));

const writeCard = async ({
  filename,
  width,
  height,
  logo,
  left,
  top,
  text,
}) => {
  const logoBuffer = await resizedLogo(logo);
  await sharp({
    create: { width, height, channels: 3, background: palette.charcoal },
  })
    .composite([
      { input: logoBuffer, left, top },
      { input: textSvg(width, height, text), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(path.join(brand, filename));
};

await Promise.all([
  writeLogo("braid-logo-readme.png", 720),
  writeLogo("braid-mark-square.png", 512),
  writeCard({
    filename: "braid-social-preview.png",
    width: 1280,
    height: 640,
    logo: 440,
    left: 72,
    top: 100,
    text: [
      {
        x: 560,
        y: 205,
        size: 104,
        fill: palette.offWhite,
        className: "wordmark",
        text: "Braid",
      },
      {
        x: 565,
        y: 300,
        size: 48,
        fill: palette.offWhite,
        className: "tagline",
        text: "Keep architecture healthy",
      },
      {
        x: 565,
        y: 365,
        size: 48,
        fill: palette.offWhite,
        className: "tagline",
        text: "while Codex writes code.",
      },
      {
        x: 568,
        y: 455,
        size: 25,
        fill: palette.mint,
        className: "support",
        text: "LIVE GUARD  •  VERIFIED MIGRATIONS",
      },
    ],
  }),
  writeCard({
    filename: "braid-video-title.png",
    width: 1920,
    height: 1080,
    logo: 660,
    left: 120,
    top: 210,
    text: [
      {
        x: 880,
        y: 390,
        size: 144,
        fill: palette.offWhite,
        className: "wordmark",
        text: "Braid",
      },
      {
        x: 890,
        y: 505,
        size: 56,
        fill: palette.offWhite,
        className: "tagline",
        text: "Keep architecture healthy",
      },
      {
        x: 890,
        y: 580,
        size: 56,
        fill: palette.offWhite,
        className: "tagline",
        text: "while Codex writes code.",
      },
      {
        x: 894,
        y: 690,
        size: 26,
        fill: palette.mint,
        className: "support",
        text: "LIVE ARCHITECTURE FEEDBACK",
      },
    ],
  }),
  writeCard({
    filename: "braid-video-end.png",
    width: 1920,
    height: 1080,
    logo: 560,
    left: 180,
    top: 260,
    text: [
      {
        x: 830,
        y: 420,
        size: 136,
        fill: palette.offWhite,
        className: "wordmark",
        text: "Braid",
      },
      {
        x: 838,
        y: 550,
        size: 53,
        fill: palette.offWhite,
        className: "tagline",
        text: "Live architecture guard for Codex",
      },
      {
        x: 842,
        y: 660,
        size: 30,
        fill: palette.mint,
        className: "support",
        text: "TING10688/BRAID",
      },
    ],
  }),
]);

process.stdout.write(
  `Rendered Braid brand assets from ${expectedSourceHash}\n`,
);
