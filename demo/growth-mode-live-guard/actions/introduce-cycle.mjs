import { writeFile } from "node:fs/promises";
import path from "node:path";

const repository = process.argv[2];
if (!repository) throw new Error("Demo repository path is required");

await writeFile(
  path.join(repository, "src", "notifications", "service.ts"),
  `import { placeOrder } from "../orders/service.js";

export const notify = (): string => "sent";

export const describeOrder = (): string => placeOrder();
`,
);
