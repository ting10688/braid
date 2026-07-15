import assert from "node:assert/strict";
import test from "node:test";
import { sendNotification } from "../dist/modules/orders/service.js";

test("sends a formatted notification", () => {
  assert.equal(sendNotification("u1", "ready"), "u1:ready");
});
