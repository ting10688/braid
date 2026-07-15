import { userName, type UserProfile } from "../users/profile.js";

export interface Order {
  id: string;
  owner: UserProfile;
}

export const orderLabel = (order: Order): string =>
  `${order.id}:${userName(order.owner)}`;
