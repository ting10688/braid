import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
const version = packageJson.version;
const artifactName = `braid-v${version}-demo-node22`;
const artifacts = path.join(repository, ".artifacts");
const distribution = path.join(artifacts, artifactName);
const bundle = path.join(distribution, "bin", "braid.mjs");

const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

const walkFiles = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported distribution entry: ${relative}`);
  }
  return files.sort();
};

const findPackage = async (input) => {
  let directory = path.dirname(path.resolve(repository, input));
  while (directory.startsWith(repository) && directory !== repository) {
    const packagePath = path.join(directory, "package.json");
    try {
      const metadata = JSON.parse(await readFile(packagePath, "utf8"));
      if (
        metadata.name &&
        metadata.version &&
        directory.includes(`${path.sep}node_modules${path.sep}`)
      )
        return { directory, metadata };
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate third-party package metadata for ${input}`);
};

const findLicense = async (directory) => {
  const candidate = (await readdir(directory))
    .sort()
    .find((name) => /^(license|licence|copying)(\..*)?$/i.test(name));
  if (!candidate) throw new Error(`Missing license file for ${directory}`);
  return readFile(path.join(directory, candidate), "utf8");
};

const thirdPartyNotices = async (metafile) => {
  const packages = new Map();
  const inputs = Object.keys(metafile.inputs)
    .filter((input) => input.includes("node_modules"))
    .sort();
  for (const input of inputs) {
    const found = await findPackage(input);
    const key = `${found.metadata.name}@${found.metadata.version}`;
    if (!packages.has(key)) packages.set(key, found);
  }

  const sections = [];
  for (const key of [...packages.keys()].sort()) {
    const { directory, metadata } = packages.get(key);
    const license = await findLicense(directory);
    sections.push(
      `## ${key}\n\nDeclared license: ${metadata.license ?? "See included license text"}\n\n` +
        `\`\`\`\`text\n${license.trim()}\n\`\`\`\``,
    );
  }

  const typescriptPackage = JSON.parse(
    await readFile(
      path.join(repository, "node_modules", "typescript", "package.json"),
      "utf8",
    ),
  );
  const typescriptLicense = await findLicense(
    path.join(repository, "node_modules", "typescript"),
  );
  sections.push(
    `## typescript@${typescriptPackage.version} (compiler code embedded by @ts-morph/common)\n\n` +
      `Declared license: ${typescriptPackage.license}\n\n` +
      `\`\`\`\`text\n${typescriptLicense.trim()}\n\`\`\`\``,
  );

  return (
    "# Third-party notices\n\n" +
    "The standalone Braid CLI contains the following bundled third-party software. Build-only " +
    "dependencies are not part of the distributed runtime.\n\n" +
    sections.join("\n\n") +
    "\n"
  );
};

await rm(distribution, { recursive: true, force: true });
await rm(path.join(artifacts, `${artifactName}.tar.gz`), { force: true });
await rm(path.join(artifacts, `${artifactName}.zip`), { force: true });
await mkdir(path.dirname(bundle), { recursive: true });

const result = await build({
  entryPoints: [path.join(repository, "apps", "cli", "src", "index.ts")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  metafile: true,
  banner: {
    js:
      'import { createRequire as __createRequire } from "node:module"; ' +
      'import { fileURLToPath as __fileURLToPath } from "node:url"; ' +
      'import { dirname as __pathDirname } from "node:path"; ' +
      "const require = __createRequire(import.meta.url); " +
      "const __filename = __fileURLToPath(import.meta.url); " +
      "const __dirname = __pathDirname(__filename);",
  },
});

await cp(
  path.join(repository, "demo", "growth-mode-live-guard"),
  path.join(distribution, "demo"),
  {
    recursive: true,
  },
);
await cp(path.join(repository, "LICENSE"), path.join(distribution, "LICENSE"));

const template = await readFile(
  path.join(repository, "distribution", "README.md"),
  "utf8",
);
await writeFile(
  path.join(distribution, "README.md"),
  template.replaceAll("{{VERSION}}", version),
);
await writeFile(
  path.join(distribution, "THIRD_PARTY_NOTICES.md"),
  await thirdPartyNotices(result.metafile),
);

const posixCli = `#!/usr/bin/env sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$directory/braid.mjs" "$@"
`;
const windowsCli = `@echo off\r\nnode "%~dp0braid.mjs" %*\r\n`;
const demoLauncher = `#!/usr/bin/env sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$directory/demo/run-demo.mjs" "$@"
`;
await writeFile(path.join(distribution, "bin", "braid"), posixCli);
await writeFile(path.join(distribution, "bin", "braid.cmd"), windowsCli);
await writeFile(path.join(distribution, "braid-demo"), demoLauncher);
await chmod(path.join(distribution, "bin", "braid"), 0o755);
await chmod(path.join(distribution, "braid-demo"), 0o755);

const payloadFiles = (await walkFiles(distribution)).filter(
  (file) => file !== "manifest.json" && file !== "SHA256SUMS",
);
const manifestFiles = [];
for (const file of payloadFiles) {
  const contents = await readFile(path.join(distribution, file));
  const metadata = await stat(path.join(distribution, file));
  manifestFiles.push({
    path: file,
    sha256: sha256(contents),
    size: metadata.size,
  });
}
const manifest = {
  schemaVersion: "1.0.0",
  name: artifactName,
  braidVersion: version,
  runtime: { node: ">=22", git: ">=2.39" },
  entrypoints: {
    cli: "bin/braid.mjs",
    posixCli: "bin/braid",
    windowsCli: "bin/braid.cmd",
    demo: "braid-demo",
    nodeDemo: "demo/run-demo.mjs",
  },
  files: manifestFiles,
};
await writeFile(
  path.join(distribution, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksumFiles = (await walkFiles(distribution)).filter(
  (file) => file !== "SHA256SUMS",
);
const checksums = [];
for (const file of checksumFiles) {
  const contents = await readFile(path.join(distribution, file));
  checksums.push(`${sha256(contents)}  ${file}`);
}
await writeFile(
  path.join(distribution, "SHA256SUMS"),
  `${checksums.join("\n")}\n`,
);

for (const file of await walkFiles(distribution)) {
  const contents = await readFile(path.join(distribution, file));
  if (contents.includes(Buffer.from(repository)))
    throw new Error(`Distribution contains developer checkout path: ${file}`);
}

await execFileAsync("tar", ["-czf", `${artifactName}.tar.gz`, artifactName], {
  cwd: artifacts,
});
await execFileAsync("zip", ["-q", "-r", `${artifactName}.zip`, artifactName], {
  cwd: artifacts,
});

process.stdout.write(`Built ${distribution}\n`);
