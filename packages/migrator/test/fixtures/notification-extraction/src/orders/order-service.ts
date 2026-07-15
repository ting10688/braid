export interface SentNotification {
  orderId: string;
  recipient: string;
  message: string;
}

export const notificationLog: string[] = [];
export const sentNotifications: SentNotification[] = [];

export const sendOrderNotification = (
  orderId: string,
  recipient: string,
  message: string,
): SentNotification => {
  const notification = { orderId, recipient, message };
  sentNotifications.push(notification);
  notificationLog.push(`${orderId}:${message}`);
  return notification;
};

export const resetNotifications = (): void => {
  notificationLog.length = 0;
  sentNotifications.length = 0;
};

export interface Order {
  id: string;
  customerEmail: string;
  totalCents: number;
  status: "placed";
}

export const placeOrder = (
  id: string,
  customerEmail: string,
  totalCents: number,
): Order => {
  if (totalCents <= 0) throw new RangeError("Order total must be positive");
  const order: Order = {
    id,
    customerEmail,
    totalCents,
    status: "placed",
  };
  sendOrderNotification(id, customerEmail, "order placed");
  return order;
};
