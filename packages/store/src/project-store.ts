import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { DEFAULT_ARCHITECTURE_CONFIG } from "@braid/core";
import {
  CONFIG_FILE,
  InvalidInputError,
  PROJECT_FILE,
  SNAPSHOTS_DIRECTORY,
} from "@braid/shared";

export interface InitializedProject {
  configPath: string;
  projectPath: string;
  snapshotsPath: string;
}

export interface ProjectStore {
  initialize(force: boolean): Promise<InitializedProject>;
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export class JsonProjectStore implements ProjectStore {
  constructor(private readonly projectRoot: string) {}

  async initialize(force: boolean): Promise<InitializedProject> {
    const configPath = path.join(this.projectRoot, CONFIG_FILE);
    const projectPath = path.join(this.projectRoot, PROJECT_FILE);
    const snapshotsPath = path.join(this.projectRoot, SNAPSHOTS_DIRECTORY);

    if (!force && ((await exists(configPath)) || (await exists(projectPath)))) {
      throw new InvalidInputError(
        `Braid is already initialized at ${this.projectRoot}; use --force to replace configuration`,
      );
    }

    await mkdir(snapshotsPath, { recursive: true });
    await writeFile(configPath, DEFAULT_ARCHITECTURE_CONFIG, {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
    await writeFile(
      projectPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projectRoot: this.projectRoot,
          configFile: CONFIG_FILE.replaceAll("\\", "/"),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: force ? "w" : "wx" },
    );

    return { configPath, projectPath, snapshotsPath };
  }
}
