import path from "node:path";
import { stat } from "node:fs/promises";
import { JsonProjectStore } from "@braid/store";
import { InvalidInputError } from "@braid/shared";

export interface InitOptions {
  force?: boolean;
}

export const initCommand = async (
  targetPath: string,
  options: InitOptions,
): Promise<void> => {
  const projectRoot = path.resolve(targetPath);
  try {
    if (!(await stat(projectRoot)).isDirectory())
      throw new Error("not a directory");
  } catch (error) {
    throw new InvalidInputError(
      `Project directory does not exist: ${projectRoot}`,
      { cause: error },
    );
  }

  const initialized = await new JsonProjectStore(projectRoot).initialize(
    options.force ?? false,
  );
  process.stdout.write(
    [
      "Braid initialized",
      `Configuration: ${initialized.configPath}`,
      `Project state: ${initialized.projectPath}`,
      `Snapshots: ${initialized.snapshotsPath}`,
      "",
    ].join("\n"),
  );
};
