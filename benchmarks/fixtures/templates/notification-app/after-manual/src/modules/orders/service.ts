import { sendNotification } from "../notifications/service.js";
import { userName } from "../users/profile.js";

export interface Order {
  id: string;
  owner: string;
  status: "created";
}

export const orderPrefix = (): string => "order";
export const createOrder = (owner: string): string => {
  const order: Order = { id: "o1", owner, status: "created" };
  return sendNotification({
    orderId: order.id,
    ownerName: userName(order.owner),
    prefix: orderPrefix(),
  });
};
