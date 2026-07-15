import { notificationChannel } from "../notifications/channel.js";

export const chargeTotal = (total: number): number => total;
export const billingLabel = (): string => `billing:${notificationChannel()}`;
