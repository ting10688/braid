import { checkout } from "../orders/checkout.js";

export const notificationChannel = (): string =>
  checkout(0) === 0 ? "email" : "unknown";
