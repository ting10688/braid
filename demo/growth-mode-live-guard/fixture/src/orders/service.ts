import { notify } from "../notifications/service.js";

export const placeOrder = (): string => `order:${notify()}`;
