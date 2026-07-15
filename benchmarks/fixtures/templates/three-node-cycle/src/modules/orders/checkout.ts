import { chargeTotal } from "../billing/charge.js";

export const checkout = (total: number): number => chargeTotal(total);
