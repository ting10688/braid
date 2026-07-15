import { notificationMessage } from "../notifications/message.js";

export const refundTotal = (total: number): number => {
  notificationMessage();
  return -total;
};
