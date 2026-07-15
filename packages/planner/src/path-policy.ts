const globExpression = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`, "u");
};

export const matchesConfiguredPath = (
  file: string,
  configuredPath: string,
): boolean => {
  const pattern = configuredPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (/[*?]/u.test(pattern)) return globExpression(pattern).test(file);
  const prefix = pattern.replace(/\/$/u, "");
  return file === prefix || file.startsWith(`${prefix}/`);
};

export const protectedFiles = (
  files: readonly string[],
  configuredPaths: readonly string[],
): string[] =>
  files
    .filter((file) =>
      configuredPaths.some((pattern) => matchesConfiguredPath(file, pattern)),
    )
    .sort();
