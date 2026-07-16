export const MIGRATOR_VERSION = "0.1.2";
export const SCOPE_POLICY_VERSION = 1;

export const FORBIDDEN_FILE_PATTERNS = [
  ".braid/**",
  ".env*",
  ".git/**",
  ".github/**",
  "LICENSE*",
  "README*",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig*.json",
  "yarn.lock",
] as const;

export const SOURCE_FINGERPRINT_EXCLUDES = [
  ".braid/executions/",
  ".braid/state/",
  ".git/",
  ".turbo/",
  "build/",
  "coverage/",
  "dist/",
  "node_modules/",
] as const;

const secretAssignment =
  /((?:["']?)(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?|DATABASE_URL))["']?\s*[:=]\s*)(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,;]{8,})/giu;

export const redactSensitiveText = (value: string): string =>
  value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
    .replace(
      /\b(?:sk-|gh[pousr]_|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}\b/gu,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[REDACTED JWT]",
    )
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu,
      "$1[REDACTED]@",
    )
    .replace(secretAssignment, (match, prefix: string) =>
      /process\.env|import\.meta\.env|Deno\.env|\$\{|redacted|placeholder|example/iu.test(
        match,
      )
        ? match
        : `${prefix}[REDACTED]`,
    );

export const containsSensitiveText = (value: string): boolean =>
  redactSensitiveText(value) !== value;
