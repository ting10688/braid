import { randomUUID } from "node:crypto";
import {
  formatMoney,
  money,
  multiplyMoney,
  sumMoney,
  type Money,
} from "#shared/money.js";
import { getUserEmail } from "../users/user-service.js";

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface Order {
  id: string;
  userId: string;
  lines: OrderLine[];
  status: "draft" | "confirmed" | "cancelled";
  total: Money;
}

const orders = new Map<string, Order>();
const sentNotifications: string[] = [];

export const calculateOrderTotal = (lines: OrderLine[]): Money =>
  sumMoney(lines.map((line) => multiplyMoney(line.unitPrice, line.quantity)));

export const createOrder = (userId: string, lines: OrderLine[]): Order => {
  if (lines.length === 0)
    throw new Error("An order requires at least one line");
  const order: Order = {
    id: randomUUID(),
    userId,
    lines: lines.map((line) => ({ ...line })),
    status: "draft",
    total: calculateOrderTotal(lines),
  };
  orders.set(order.id, order);
  return order;
};

export const confirmOrder = (orderId: string): Order => {
  const order = requireOrder(orderId);
  if (order.status !== "draft")
    throw new Error("Only draft orders can be confirmed");
  order.status = "confirmed";
  // Intentional architecture problem: notification delivery is mixed into order logic.
  const message = `Order ${order.id} confirmed for ${getUserEmail(order.userId)}: ${formatMoney(order.total)}`;
  sentNotifications.push(message);
  return order;
};

export const cancelOrder = (orderId: string): Order => {
  const order = requireOrder(orderId);
  if (order.status === "cancelled") throw new Error("Order already cancelled");
  order.status = "cancelled";
  sentNotifications.push(
    `Order ${order.id} cancelled for ${getUserEmail(order.userId)}`,
  );
  return order;
};

export const duplicateOrder = (orderId: string): Order => {
  const original = requireOrder(orderId);
  return createOrder(
    original.userId,
    original.lines.map((line) => ({ ...line })),
  );
};

export const addLine = (orderId: string, line: OrderLine): Order => {
  const order = requireDraftOrder(orderId);
  order.lines.push({ ...line });
  order.total = calculateOrderTotal(order.lines);
  return order;
};

export const removeLine = (orderId: string, sku: string): Order => {
  const order = requireDraftOrder(orderId);
  order.lines = order.lines.filter((line) => line.sku !== sku);
  order.total = calculateOrderTotal(order.lines);
  return order;
};

export const getOrder = (orderId: string): Order | undefined =>
  orders.get(orderId);

export const listOrders = (userId: string): Order[] =>
  [...orders.values()].filter((order) => order.userId === userId);

export const getOrderTotal = (userId: string): number =>
  listOrders(userId).reduce((total, order) => total + order.total.amount, 0);

export const notificationLog = (): string[] => [...sentNotifications];

export const clearOrders = (): void => {
  orders.clear();
  sentNotifications.length = 0;
};

const requireOrder = (orderId: string): Order => {
  const order = orders.get(orderId);
  if (!order) throw new Error(`Unknown order: ${orderId}`);
  return order;
};

const requireDraftOrder = (orderId: string): Order => {
  const order = requireOrder(orderId);
  if (order.status !== "draft") throw new Error("Order is not editable");
  return order;
};

export const sampleOrder = (): Order =>
  createOrder("user-1", [{ sku: "DEMO", quantity: 1, unitPrice: money(2500) }]);
