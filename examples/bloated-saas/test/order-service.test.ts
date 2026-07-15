import { beforeEach, describe, expect, it } from "vitest";
import {
  addLine,
  calculateOrderTotal,
  cancelOrder,
  clearOrders,
  confirmOrder,
  createOrder,
  duplicateOrder,
  getOrder,
  listOrders,
  notificationLog,
  removeLine,
} from "../src/orders/order-service.js";
import { money } from "../src/shared/money.js";

describe("order service", () => {
  beforeEach(clearOrders);

  it.each([
    [1, 100, 100],
    [2, 100, 200],
    [3, 100, 300],
    [4, 100, 400],
    [5, 100, 500],
    [1, 250, 250],
    [2, 250, 500],
    [3, 250, 750],
    [4, 250, 1000],
    [5, 250, 1250],
    [1, 999, 999],
    [2, 999, 1998],
    [3, 999, 2997],
    [4, 999, 3996],
    [5, 999, 4995],
    [6, 25, 150],
    [7, 25, 175],
    [8, 25, 200],
    [9, 25, 225],
    [10, 25, 250],
  ])("calculates %i × %i", (quantity, cents, expected) => {
    expect(
      calculateOrderTotal([{ sku: "A", quantity, unitPrice: money(cents) }])
        .amount,
    ).toBe(expected);
  });

  it("creates, edits, and reads an order", () => {
    const order = createOrder("user-1", [
      { sku: "A", quantity: 1, unitPrice: money(100) },
    ]);
    addLine(order.id, { sku: "B", quantity: 2, unitPrice: money(50) });
    removeLine(order.id, "A");
    expect(getOrder(order.id)?.total.amount).toBe(100);
    expect(listOrders("user-1")).toHaveLength(1);
  });

  it("confirms and notifies", () => {
    const order = createOrder("user-1", [
      { sku: "A", quantity: 1, unitPrice: money(100) },
    ]);
    expect(confirmOrder(order.id).status).toBe("confirmed");
    expect(notificationLog()[0]).toContain("owner@example.com");
  });

  it("cancels an order", () => {
    const order = createOrder("user-2", [
      { sku: "A", quantity: 1, unitPrice: money(100) },
    ]);
    expect(cancelOrder(order.id).status).toBe("cancelled");
  });

  it("duplicates an order", () => {
    const order = createOrder("user-1", [
      { sku: "A", quantity: 2, unitPrice: money(100) },
    ]);
    const copy = duplicateOrder(order.id);
    expect(copy.id).not.toBe(order.id);
    expect(copy.total).toEqual(order.total);
  });
});
