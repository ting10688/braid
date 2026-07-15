import { refundTotal } from "../billing/refund.js";

export const refund = (total: number): number => refundTotal(total);
