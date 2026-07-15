import assert from "node:assert/strict";
import test from "node:test";
import { createOrder } from "../dist/index.js";

test("creates an order and sends the same notification", () => {
  assert.equal(createOrder("u1"), "o1:Ada:order:email");
});
