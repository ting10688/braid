export const SYMBOL_STOP_WORDS = new Set([
  "add",
  "base",
  "build",
  "calculate",
  "cancel",
  "clear",
  "common",
  "confirm",
  "create",
  "default",
  "delete",
  "duplicate",
  "get",
  "handle",
  "handler",
  "helper",
  "internal",
  "make",
  "manager",
  "list",
  "process",
  "remove",
  "require",
  "sample",
  "service",
  "set",
  "update",
  "util",
  "utils",
]);

const singular = (token: string): string =>
  token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;

export const tokenizeSymbolName = (name: string): string[] =>
  [
    ...new Set(
      name
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
        .split(/[^A-Za-z0-9]+/u)
        .map((token) => singular(token.toLowerCase()))
        .filter((token) => token.length > 1 && !SYMBOL_STOP_WORDS.has(token)),
    ),
  ].sort();
