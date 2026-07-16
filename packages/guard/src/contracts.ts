import type {
  GrowthModeAdapterCompatibility,
  GrowthModeBaselineIdentity,
  GrowthModeCurrentIdentity,
  GrowthModeReport,
} from "@braid/core";

export const GROWTH_GUARD_VERSION = "0.1.0" as const;

export const CLI_ADAPTER_COMPATIBILITY: GrowthModeAdapterCompatibility = {
  protocolVersion: "1.0.0",
  adapter: "braid-cli",
  adapterVersion: GROWTH_GUARD_VERSION,
  providerVersion: null,
  supportedEvents: [],
  capabilities: {
    sessionContext: false,
    promptContext: false,
    postToolContext: false,
    stopBlocking: false,
    repositoryLocalConfiguration: false,
    requiresTrust: false,
  },
};

export interface GrowthGuardOptions {
  projectRoot: string;
  sessionId: string;
  compatibility?: GrowthModeAdapterCompatibility;
  now?: () => Date;
}

export interface GrowthModeContextResult {
  report: GrowthModeReport;
  text: string;
  initialized: boolean;
}

export interface GrowthModeCheckResult {
  report: GrowthModeReport;
  feedback: string | null;
}

export interface GrowthModeFinalResult extends GrowthModeCheckResult {
  shouldBlock: boolean;
  unresolvedCompletion: boolean;
  stopAttemptsForFingerprint: number;
}

export interface GrowthModeLifecycleStatus {
  enabled: boolean;
  sessionId: string;
  baselineExists: boolean;
  baseline: GrowthModeBaselineIdentity | null;
  current: GrowthModeCurrentIdentity | null;
  latestReport: GrowthModeReport | null;
  unresolvedCompletion: boolean;
}

export interface GrowthGuardLifecycle {
  context(): Promise<GrowthModeContextResult>;
  check(): Promise<GrowthModeCheckResult>;
  final(): Promise<GrowthModeFinalResult>;
  status(): Promise<GrowthModeLifecycleStatus>;
  reset(): Promise<boolean>;
}

export type GrowthGuardFactory = (
  options: GrowthGuardOptions,
) => GrowthGuardLifecycle;
