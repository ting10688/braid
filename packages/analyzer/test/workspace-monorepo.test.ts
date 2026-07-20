import path from "node:path";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ARCHITECTURE_CONFIG,
  parseArchitectureConfig,
} from "@braid/core";
import { analyzeRepository, type AnalysisResult } from "../src/index.js";

const temporaryDirectories: string[] = [];
const config = parseArchitectureConfig(
  DEFAULT_ARCHITECTURE_CONFIG.replace(
    "    - src/**/*.tsx",
    "    - src/**/*.tsx\n    - packages/**/src/**/*.ts",
  ),
);

const acyclicPackages = [
  {
    directory: "kernel",
    name: "@fixture/kernel",
    files: {
      "src/index.ts": [
        'import type { KernelTypes } from "./types.js";',
        "export interface Kernel { types: KernelTypes }",
      ].join("\n"),
      "src/types.ts": 'export interface KernelTypes { kind: "kernel" }\n',
      "src/driver.ts": 'export const driver = "kernel";\n',
      "src/protocol/index.ts": 'export const protocol = "kernel";\n',
    },
  },
  {
    directory: "protocol",
    name: "@fixture/protocol",
    files: {
      "src/index.ts": [
        'import type { Kernel } from "@fixture/kernel";',
        "export interface Protocol { kernel: Kernel }",
      ].join("\n"),
      "src/types.ts": 'export interface ProtocolTypes { kind: "protocol" }\n',
      "src/driver.ts": 'export const driver = "protocol";\n',
      "src/protocol/index.ts": 'export const protocol = "protocol";\n',
    },
  },
  {
    directory: "transport",
    name: "@fixture/transport",
    files: {
      "src/index.ts": [
        'import type { Protocol } from "@fixture/protocol";',
        "export interface Transport { protocol: Protocol }",
      ].join("\n"),
      "src/types.ts": 'export interface TransportTypes { kind: "transport" }\n',
      "src/driver.ts": 'export const driver = "transport";\n',
      "src/protocol/index.ts": 'export const protocol = "transport";\n',
    },
  },
  {
    directory: "client",
    name: "@fixture/client",
    files: {
      "src/index.ts": [
        'import type { ExternalWidget } from "third-party";',
        'import type { ClientTypes } from "./types.js";',
        "export interface Client { types: ClientTypes; widget?: ExternalWidget }",
      ].join("\n"),
      "src/types.ts": [
        'import type { Transport } from "@fixture/transport";',
        "export interface ClientTypes { transport: Transport }",
      ].join("\n"),
      "src/driver.ts": 'export const driver = "client";\n',
      "src/protocol/index.ts": 'export const protocol = "client";\n',
    },
  },
] as const;

const cyclePackages = [
  {
    directory: "cycle-a",
    name: "@fixture/cycle-a",
    files: {
      "src/index.ts": [
        'import type { CycleB } from "@fixture/cycle-b";',
        "export interface CycleA { next: CycleB }",
      ].join("\n"),
    },
  },
  {
    directory: "cycle-b",
    name: "@fixture/cycle-b",
    files: {
      "src/index.ts": [
        'import type { CycleA } from "@fixture/cycle-a";',
        "export interface CycleB { next: CycleA }",
      ].join("\n"),
    },
  },
] as const;

const createFixture = async (
  packages: readonly {
    directory: string;
    name: string;
    files: Readonly<Record<string, string>>;
  }[],
  reverseWrites = false,
): Promise<string> => {
  const root = await mkdtemp(
    path.join(await realpath(tmpdir()), "braid-workspaces-"),
  );
  temporaryDirectories.push(root);
  const entries: Array<readonly [string, string]> = [
    [
      "package.json",
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    ],
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
        },
      }),
    ],
    ...packages.flatMap(({ directory, name, files }) => [
      [
        `packages/${directory}/package.json`,
        JSON.stringify({
          name,
          type: "module",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
          types: "./dist/index.d.ts",
        }),
      ] as const,
      [
        `packages/${directory}/dist/index.d.ts`,
        'export * from "../src/index.js";\n',
      ] as const,
      ...Object.entries(files).map(
        ([file, contents]) =>
          [`packages/${directory}/${file}`, contents] as const,
      ),
    ]),
  ];

  for (const [file, contents] of reverseWrites ? entries.reverse() : entries) {
    const destination = path.join(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const installWorkspaceLinks = async (
  root: string,
  packages: readonly { directory: string; name: string }[],
): Promise<void> => {
  const scope = path.join(root, "node_modules", "@fixture");
  await mkdir(scope, { recursive: true });
  for (const { directory, name } of packages)
    await symlink(
      path.join("..", "..", "packages", directory),
      path.join(scope, name.slice("@fixture/".length)),
      "dir",
    );

  const thirdParty = path.join(root, "node_modules", "third-party");
  await mkdir(thirdParty, { recursive: true });
  await writeFile(
    path.join(thirdParty, "package.json"),
    JSON.stringify({ name: "third-party", types: "./index.d.ts" }),
  );
  await writeFile(
    path.join(thirdParty, "index.d.ts"),
    "export interface ExternalWidget { id: string }\n",
  );
};

const topology = ({ repository }: AnalysisResult) => ({
  moduleIds: repository.modules.map(({ id }) => id),
  internalEdges: repository.imports.filter(({ kind }) => kind === "internal"),
  cycles: repository.cycles,
});

const moduleIdsFor = (
  result: AnalysisResult,
  files: readonly string[],
): Array<string | undefined> =>
  files.map(
    (file) =>
      result.repository.modules.find(({ paths }) => paths.includes(file))?.id,
  );

const workspaceId = (directory: string, moduleId: string): string => {
  const packageDirectory = `packages/${directory}`;
  return `workspace:${packageDirectory.length}:${packageDirectory}/${moduleId}`;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workspace monorepo analysis", () => {
  it("keeps workspace identities and topology stable with or without installed links", async () => {
    const root = await createFixture(acyclicPackages);
    const withoutLinks = await analyzeRepository(root, config);
    const repeated = await analyzeRepository(root, config);
    const reorderedRoot = await createFixture(acyclicPackages, true);
    const reordered = await analyzeRepository(reorderedRoot, config);
    await installWorkspaceLinks(root, acyclicPackages);
    const withLinks = await analyzeRepository(root, config);
    const packageDirectories = acyclicPackages
      .map(({ directory }) => directory)
      .sort();

    expect
      .soft(
        withLinks.repository.modules
          .filter(({ kind }) => kind === "entrypoint")
          .map(({ id }) => id),
      )
      .toEqual(
        packageDirectories.map((directory) =>
          workspaceId(directory, "entrypoint:index"),
        ),
      );
    expect
      .soft(
        moduleIdsFor(
          withLinks,
          packageDirectories.map(
            (directory) => `packages/${directory}/src/types.ts`,
          ),
        ),
      )
      .toEqual(
        packageDirectories.map((directory) =>
          workspaceId(directory, "root:types"),
        ),
      );
    expect
      .soft(
        moduleIdsFor(
          withLinks,
          packageDirectories.map(
            (directory) => `packages/${directory}/src/driver.ts`,
          ),
        ),
      )
      .toEqual(
        packageDirectories.map((directory) =>
          workspaceId(directory, "root:driver"),
        ),
      );
    expect
      .soft(
        moduleIdsFor(
          withLinks,
          packageDirectories.map(
            (directory) => `packages/${directory}/src/protocol/index.ts`,
          ),
        ),
      )
      .toEqual(
        packageDirectories.map((directory) =>
          workspaceId(directory, "protocol"),
        ),
      );

    expect.soft(topology(withLinks)).toEqual(topology(withoutLinks));
    expect.soft(topology(repeated)).toEqual(topology(withoutLinks));
    expect.soft(topology(reordered)).toEqual(topology(withoutLinks));
    expect.soft(withoutLinks.repository.cycles).toEqual([]);
    expect.soft(withLinks.repository.cycles).toEqual([]);

    const expectedExternal = [
      {
        fromFile: "packages/client/src/index.ts",
        toFile: "third-party",
        fromModule: workspaceId("client", "entrypoint:index"),
        toModule: "third-party",
        kind: "external",
        typeOnly: true,
      },
    ];
    expect
      .soft(
        withoutLinks.repository.imports.filter(
          ({ kind }) => kind === "external",
        ),
      )
      .toEqual(expectedExternal);
    expect
      .soft(
        withLinks.repository.imports.filter(({ kind }) => kind === "external"),
      )
      .toEqual(expectedExternal);
  });

  it("reports one genuine cycle across two workspaces", async () => {
    const root = await createFixture(cyclePackages);
    const withoutLinks = await analyzeRepository(root, config);
    await installWorkspaceLinks(root, cyclePackages);
    const withLinks = await analyzeRepository(root, config);
    const expectedCycle = [
      {
        modules: [
          workspaceId("cycle-a", "entrypoint:index"),
          workspaceId("cycle-b", "entrypoint:index"),
        ],
        files: [
          "packages/cycle-a/src/index.ts",
          "packages/cycle-b/src/index.ts",
        ],
      },
    ];

    expect(withoutLinks.repository.cycles).toEqual(expectedCycle);
    expect(withLinks.repository.cycles).toEqual(expectedCycle);
  });

  it("keeps package boundaries distinct from module path segments", async () => {
    const root = await createFixture([
      {
        directory: "a",
        name: "@fixture/a",
        files: {
          "src/index.ts": "export const root = true;\n",
          "src/modules/x/file.ts": "export const outer = true;\n",
        },
      },
      {
        directory: "a/modules",
        name: "@fixture/a-modules",
        files: {
          "src/index.ts": "export const root = true;\n",
          "src/x/file.ts": "export const nested = true;\n",
        },
      },
    ]);
    const result = await analyzeRepository(root, config);

    expect(
      moduleIdsFor(result, [
        "packages/a/src/modules/x/file.ts",
        "packages/a/modules/src/x/file.ts",
      ]),
    ).toEqual([workspaceId("a", "modules/x"), workspaceId("a/modules", "x")]);
  });
});
