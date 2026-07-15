export interface Money {
  amount: number;
  currency: "USD" | "EUR" | "TWD";
}

export const money = (
  amount: number,
  currency: Money["currency"] = "USD",
): Money => ({
  amount,
  currency,
});

export const addMoney = (left: Money, right: Money): Money => {
  if (left.currency !== right.currency) throw new Error("Currency mismatch");
  return money(left.amount + right.amount, left.currency);
};

export const subtractMoney = (left: Money, right: Money): Money => {
  if (left.currency !== right.currency) throw new Error("Currency mismatch");
  return money(left.amount - right.amount, left.currency);
};

export const multiplyMoney = (value: Money, quantity: number): Money =>
  money(value.amount * quantity, value.currency);

export const formatMoney = (value: Money): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: value.currency,
  }).format(value.amount / 100);

export const isPositive = (value: Money): boolean => value.amount > 0;

export const zero = (currency: Money["currency"] = "USD"): Money =>
  money(0, currency);

export const sumMoney = (values: Money[]): Money => {
  const currency = values[0]?.currency ?? "USD";
  return values.reduce(
    (total, value) => addMoney(total, value),
    zero(currency),
  );
};

export const percentage = (value: Money, rate: number): Money =>
  money(Math.round(value.amount * rate), value.currency);

export const clampMoney = (
  value: Money,
  minimum: Money,
  maximum: Money,
): Money => {
  if (
    value.currency !== minimum.currency ||
    value.currency !== maximum.currency
  ) {
    throw new Error("Currency mismatch");
  }
  return money(
    Math.min(Math.max(value.amount, minimum.amount), maximum.amount),
    value.currency,
  );
};

export const parseMoney = (
  value: string,
  currency: Money["currency"] = "USD",
): Money => {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount))
    throw new Error(`Invalid money value: ${value}`);
  return money(Math.round(amount * 100), currency);
};
