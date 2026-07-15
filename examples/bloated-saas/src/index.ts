import { confirmOrder, sampleOrder } from "./orders/index.js";

export * from "./orders/index.js";
export * from "./users/index.js";

if (process.argv[1]?.endsWith("index.js")) {
  const order = sampleOrder();
  confirmOrder(order.id);
  process.stdout.write(`Confirmed ${order.id}\n`);
}
