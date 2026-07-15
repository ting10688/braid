import path from "node:path";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  migrationProposalSchema,
  type MigrationProposal,
  type ProposalEvidence,
} from "@braid/core";
import { PersistenceError, PROPOSALS_DIRECTORY } from "@braid/shared";

export interface ProposalStore {
  save(proposal: MigrationProposal): Promise<string>;
  load(proposalId: string): Promise<MigrationProposal>;
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right);
const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compare);

const normalizeEvidence = (evidence: ProposalEvidence): ProposalEvidence => {
  switch (evidence.type) {
    case "dependency-cycle":
      return { ...evidence, files: sorted(evidence.files) };
    case "cycle-edge":
      return { ...evidence, importingFiles: sorted(evidence.importingFiles) };
    case "symbol-cluster":
      return {
        ...evidence,
        symbols: sorted(evidence.symbols),
        sharedTokens: sorted(evidence.sharedTokens),
      };
    case "public-entrypoint-impact":
    case "protected-path-impact":
      return { ...evidence, files: sorted(evidence.files) };
    default:
      return evidence;
  }
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
};

const normalizeImpact = (impact: MigrationProposal["expectedImpact"]) => ({
  simulated: [...impact.simulated].sort((left, right) =>
    compare(
      `${left.metric}\0${left.rationale}`,
      `${right.metric}\0${right.rationale}`,
    ),
  ),
  estimated: [...impact.estimated].sort((left, right) =>
    compare(
      `${left.metric}\0${left.rationale}`,
      `${right.metric}\0${right.rationale}`,
    ),
  ),
  unknowns: sorted(impact.unknowns),
});

const normalizeRisk = (risk: MigrationProposal["risk"]) => ({
  ...risk,
  factors: [...risk.factors].sort((left, right) =>
    compare(`${left.type}\0${left.details}`, `${right.type}\0${right.details}`),
  ),
});

export const normalizeProposal = (
  proposal: MigrationProposal,
): MigrationProposal => {
  const target =
    proposal.target.type === "extract-module"
      ? {
          ...proposal.target,
          candidateSymbols: sorted(proposal.target.candidateSymbols),
          ...(proposal.target.approvedCompanionSymbols
            ? {
                approvedCompanionSymbols: [
                  ...proposal.target.approvedCompanionSymbols,
                ].sort((left, right) =>
                  compare(
                    `${left.file}\0${left.symbol}`,
                    `${right.file}\0${right.symbol}`,
                  ),
                ),
              }
            : {}),
        }
      : {
          ...proposal.target,
          cycleFiles: sorted(proposal.target.cycleFiles),
          selectedEdge: {
            ...proposal.target.selectedEdge,
            files: sorted(proposal.target.selectedEdge.files),
          },
        };
  const evidence = proposal.evidence
    .map(normalizeEvidence)
    .sort((left, right) =>
      compare(
        JSON.stringify(stableValue(left)),
        JSON.stringify(stableValue(right)),
      ),
    );
  const alternatives = proposal.alternatives
    ?.map((alternative) => ({
      ...alternative,
      selectedEdge: {
        ...alternative.selectedEdge,
        files: sorted(alternative.selectedEdge.files),
      },
      affectedFiles: sorted(alternative.affectedFiles),
      affectedModules: sorted(alternative.affectedModules),
      evidence: alternative.evidence
        .map(normalizeEvidence)
        .sort((left, right) =>
          compare(
            JSON.stringify(stableValue(left)),
            JSON.stringify(stableValue(right)),
          ),
        ),
      expectedImpact: normalizeImpact(alternative.expectedImpact),
      risk: normalizeRisk(alternative.risk),
      reversibility: {
        ...alternative.reversibility,
        factors: sorted(alternative.reversibility.factors),
      },
    }))
    .sort((left, right) =>
      compare(
        `${left.selectedEdge.fromModule}\0${left.selectedEdge.toModule}\0${left.strategy}`,
        `${right.selectedEdge.fromModule}\0${right.selectedEdge.toModule}\0${right.strategy}`,
      ),
    );
  return migrationProposalSchema.parse({
    ...proposal,
    affectedFiles: sorted(proposal.affectedFiles),
    affectedModules: sorted(proposal.affectedModules),
    target,
    evidence,
    expectedImpact: normalizeImpact(proposal.expectedImpact),
    risk: normalizeRisk(proposal.risk),
    reversibility: {
      ...proposal.reversibility,
      factors: sorted(proposal.reversibility.factors),
    },
    preconditions: sorted(proposal.preconditions),
    constraints: sorted(proposal.constraints),
    ...(alternatives ? { alternatives } : {}),
  });
};

export const serializeProposal = (proposal: MigrationProposal): string =>
  `${JSON.stringify(stableValue(normalizeProposal(proposal)), null, 2)}\n`;

const semanticContent = (proposal: MigrationProposal): string =>
  serializeProposal({ ...proposal, snapshotId: "S-content-equivalent" });

const readExisting = async (
  filePath: string,
): Promise<MigrationProposal | null> => {
  try {
    return migrationProposalSchema.parse(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export class JsonProposalStore implements ProposalStore {
  constructor(private readonly projectRoot: string) {}

  async save(proposalInput: MigrationProposal): Promise<string> {
    const proposal = normalizeProposal(proposalInput);
    const directory = path.join(this.projectRoot, PROPOSALS_DIRECTORY);
    const destination = path.join(directory, `${proposal.id}.json`);
    const temporary = path.join(
      directory,
      `.${proposal.id}-${randomUUID()}.tmp`,
    );

    try {
      const existing = await readExisting(destination);
      if (existing) {
        if (semanticContent(existing) === semanticContent(proposal))
          return destination;
        throw new PersistenceError(
          `Proposal ID ${proposal.id} already contains different content`,
        );
      }
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, serializeProposal(proposal), {
        encoding: "utf8",
        flag: "wx",
      });
      await link(temporary, destination);
      return destination;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const existing = await readExisting(destination);
          if (
            existing &&
            semanticContent(existing) === semanticContent(proposal)
          )
            return destination;
        } catch {
          // The persistence error below retains the original failure as cause.
        }
      }
      throw new PersistenceError(`Could not persist proposal ${proposal.id}`, {
        cause: error,
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async load(proposalId: string): Promise<MigrationProposal> {
    if (!/^P-(?:EM|BC)-[a-f0-9]{8}$/u.test(proposalId))
      throw new PersistenceError(`Invalid proposal ID: ${proposalId}`);
    try {
      const proposal = await readExisting(
        path.join(this.projectRoot, PROPOSALS_DIRECTORY, `${proposalId}.json`),
      );
      if (!proposal) throw new Error("proposal file does not exist");
      return proposal;
    } catch (error) {
      throw new PersistenceError(`Could not load proposal ${proposalId}`, {
        cause: error,
      });
    }
  }
}
