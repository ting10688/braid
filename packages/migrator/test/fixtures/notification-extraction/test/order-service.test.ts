import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  notificationLog,
  placeOrder,
  resetNotifications,
  sendOrderNotification,
  sentNotifications,
} from "../src/orders/order-service.ts";

beforeEach(() => resetNotifications());

test("placing an order records one notification", () => {
  const order = placeOrder("order-1", "buyer@example.test", 2500);

  assert.deepEqual(order, {
    id: "order-1",
    customerEmail: "buyer@example.test",
    totalCents: 2500,
    status: "placed",
  });
  assert.deepEqual(sentNotifications, [
    {
      orderId: "order-1",
      recipient: "buyer@example.test",
      message: "order placed",
    },
  ]);
  assert.deepEqual(notificationLog, ["order-1:order placed"]);
});

test("notification delivery is reusable by order workflows", () => {
  const sent = sendOrderNotification(
    "order-2",
    "ops@example.test",
    "ready to ship",
  );

  assert.equal(sentNotifications[0], sent);
  assert.deepEqual(notificationLog, ["order-2:ready to ship"]);
});

test("invalid totals do not send notifications", () => {
  assert.throws(
    () => placeOrder("order-3", "buyer@example.test", 0),
    /positive/u,
  );
  assert.equal(sentNotifications.length, 0);
});
