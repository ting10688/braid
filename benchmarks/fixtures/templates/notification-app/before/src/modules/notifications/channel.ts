import { orderPrefix } from "../orders/service.js";

export const deliveryChannel = (): string => `${orderPrefix()}:email`;
