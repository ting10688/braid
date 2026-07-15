import { getOrderTotal } from "../orders/order-service.js";

const users = new Map([
  ["user-1", { id: "user-1", email: "owner@example.com" }],
  ["user-2", { id: "user-2", email: "buyer@example.com" }],
]);

export const getUserEmail = (userId: string): string => {
  const user = users.get(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  return user.email;
};

// Intentional reverse dependency: user reporting reaches into orders.
export const getCustomerLifetimeValue = (userId: string): number =>
  getOrderTotal(userId);
