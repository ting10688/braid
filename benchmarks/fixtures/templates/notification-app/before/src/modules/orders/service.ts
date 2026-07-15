import { deliveryChannel } from "../notifications/channel.js";
import { userName } from "../users/profile.js";

export interface Order {
  id: string;
  owner: string;
  status: "created";
}

export const orderPrefix = (): string => "order";
export const notificationLog: string[] = [];
export const formatNotification = (order: Order): string =>
  `${order.id}:${userName(order.owner)}:${deliveryChannel()}`;
export const sendNotification = (order: Order): void => {
  notificationLog.push(formatNotification(order));
};
export const createOrder = (owner: string): string => {
  const order: Order = { id: "o1", owner, status: "created" };
  sendNotification(order);
  return notificationLog.at(-1)!;
};
