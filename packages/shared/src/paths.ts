import path from "node:path";

export const BRAID_DIRECTORY = ".braid";
export const CONFIG_FILE = path.join(BRAID_DIRECTORY, "architecture.yaml");
export const STATE_DIRECTORY = path.join(BRAID_DIRECTORY, "state");
export const PROJECT_FILE = path.join(STATE_DIRECTORY, "project.json");
export const SNAPSHOTS_DIRECTORY = path.join(STATE_DIRECTORY, "snapshots");

export const toPosixPath = (value: string): string =>
  value.split(path.sep).join("/");

export const projectRelativePath = (
  projectRoot: string,
  absolutePath: string,
): string => toPosixPath(path.relative(projectRoot, absolutePath));
