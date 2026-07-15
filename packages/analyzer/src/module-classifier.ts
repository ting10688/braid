import path from "node:path";

export const classifyModule = (filePath: string): string => {
  const segments = filePath.replaceAll("\\", "/").split("/");
  const sourceIndex = segments.lastIndexOf("src");
  const belowSource = segments.slice(sourceIndex + 1);
  const first = belowSource[0];

  if (!first || path.posix.extname(first)) return "root";
  if (
    first === "modules" &&
    belowSource[1] &&
    !path.posix.extname(belowSource[1])
  ) {
    return `modules/${belowSource[1]}`;
  }
  return first;
};
