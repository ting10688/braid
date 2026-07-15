export const notificationLog: string[] = [];

export const formatNotification = (
  recipient: string,
  message: string,
): string => `${recipient}:${message}`;

export const sendNotification = (
  recipient: string,
  message: string,
): string => {
  const formatted = formatNotification(recipient, message);
  notificationLog.push(formatted);
  return formatted;
};

export const retryNotification = (recipient: string, message: string): string =>
  sendNotification(recipient, message);

export interface OrderRecord {
  id: string;
  total: number;
}

export const orderTotal = (order: OrderRecord): number => order.total;

export interface UserRecord {
  id: string;
  displayName: string;
}

export const userDisplayName = (user: UserRecord): string => user.displayName;

export const createOrder = (id: string, total: number): OrderRecord => ({
  id,
  total,
});
