import path from "node:path";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  architectureSnapshotSchema,
  type ArchitectureSnapshot,
  type RepositoryModel,
} from "@braid/core";
import { PersistenceError, SNAPSHOTS_DIRECTORY } from "@braid/shared";

export interface SnapshotStore {
  save(snapshot: ArchitectureSnapshot): Promise<string>;
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);

export const normalizeSnapshot = (
  snapshot: ArchitectureSnapshot,
): ArchitectureSnapshot => {
  const repository: RepositoryModel = {
    ...snapshot.repository,
    files: snapshot.repository.files
      .map((file) => ({
        ...file,
        exportedSymbols: [...file.exportedSymbols].sort(compare),
        importedFiles: [...file.importedFiles].sort(compare),
      }))
      .sort((left, right) => compare(left.path, right.path)),
    modules: snapshot.repository.modules
      .map((module) => ({
        ...module,
        paths: [...module.paths].sort(compare),
        incomingDependencies: [...module.incomingDependencies].sort(compare),
        outgoingDependencies: [...module.outgoingDependencies].sort(compare),
      }))
      .sort((left, right) => compare(left.id, right.id)),
    imports: [...snapshot.repository.imports].sort((left, right) =>
      compare(
        `${left.fromFile}\0${left.toFile}\0${left.kind}`,
        `${right.fromFile}\0${right.toFile}\0${right.kind}`,
      ),
    ),
    cycles: snapshot.repository.cycles
      .map((cycle) => ({
        modules: [...cycle.modules],
        files: [...cycle.files].sort(compare),
      }))
      .sort((left, right) =>
        compare(
          `${left.modules.join("\0")}|${left.files.join("\0")}`,
          `${right.modules.join("\0")}|${right.files.join("\0")}`,
        ),
      ),
    publicEntrypoints: [...snapshot.repository.publicEntrypoints].sort(compare),
  };
  return architectureSnapshotSchema.parse({ ...snapshot, repository });
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

export const serializeSnapshot = (snapshot: ArchitectureSnapshot): string =>
  `${JSON.stringify(stableValue(normalizeSnapshot(snapshot)), null, 2)}\n`;

export class JsonSnapshotStore implements SnapshotStore {
  constructor(private readonly projectRoot: string) {}

  async save(snapshot: ArchitectureSnapshot): Promise<string> {
    const directory = path.join(this.projectRoot, SNAPSHOTS_DIRECTORY);
    const destination = path.join(directory, `${snapshot.id}.json`);
    const temporary = path.join(
      directory,
      `.${snapshot.id}-${randomUUID()}.tmp`,
    );

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, serializeSnapshot(snapshot), {
        encoding: "utf8",
        flag: "wx",
      });
      await link(temporary, destination);
      return destination;
    } catch (error) {
      throw new PersistenceError(`Could not persist snapshot ${snapshot.id}`, {
        cause: error,
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
