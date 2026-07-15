import path from "node:path";
import { loadArchitectureConfig, type ProposalType } from "@braid/core";
import { generateMigrationProposals } from "@braid/planner";
import { CONFIG_FILE, InvalidInputError } from "@braid/shared";
import { JsonProposalStore, JsonSnapshotStore } from "@braid/store";
import { createCurrentSnapshot } from "./analyze.js";
import { formatProposalReport } from "../output/proposal-reporter.js";

export interface ProposeOptions {
  json?: boolean;
  save?: boolean;
  limit?: string | number;
  type?: string;
  snapshot?: string;
}

const proposalType = (value: string | undefined): ProposalType | undefined => {
  if (value === undefined) return undefined;
  if (value === "extract-module" || value === "break-cycle") return value;
  throw new InvalidInputError(
    `Invalid proposal type '${value}'; expected extract-module or break-cycle`,
  );
};

const proposalLimit = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new InvalidInputError(
      `Invalid proposal limit '${value}'; expected a positive integer`,
    );
  return parsed;
};

export const proposeCommand = async (
  targetPath: string,
  options: ProposeOptions,
): Promise<void> => {
  const projectRoot = path.resolve(targetPath);
  const config = await loadArchitectureConfig(
    path.join(projectRoot, CONFIG_FILE),
  );
  const snapshotStore = new JsonSnapshotStore(projectRoot);
  const type = proposalType(options.type);
  const limit = proposalLimit(options.limit);
  let warnings: string[] = [];
  const snapshot = options.snapshot
    ? await snapshotStore.load(options.snapshot)
    : await createCurrentSnapshot(projectRoot, config).then((current) => {
        warnings = current.warnings;
        return current.snapshot;
      });
  const hasDeclarationFacts = snapshot.repository.files.some(
    (file) => file.declarations !== undefined,
  );
  if (options.snapshot && type === "extract-module" && !hasDeclarationFacts)
    throw new InvalidInputError(
      `Snapshot ${snapshot.id} does not contain declaration facts; run a fresh analysis`,
    );
  if (options.snapshot && !type && !hasDeclarationFacts)
    warnings.push(
      `Snapshot ${snapshot.id} lacks declaration facts; extract-module proposals were skipped`,
    );
  const proposals = generateMigrationProposals(snapshot, config, {
    ...(type ? { type } : {}),
    ...(limit === undefined ? {} : { limit }),
  });

  if (options.save !== false) {
    if (!options.snapshot) await snapshotStore.save(snapshot);
    const proposalStore = new JsonProposalStore(projectRoot);
    for (const proposal of proposals) await proposalStore.save(proposal);
  }
  for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ snapshotId: snapshot.id, proposals }, null, 2)}\n`
      : `${formatProposalReport(projectRoot, snapshot.id, proposals)}\n`,
  );
};
