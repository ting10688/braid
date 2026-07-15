export interface NotificationInput {
  orderId: string;
  ownerName: string;
  prefix: string;
}

export const notificationLog: string[] = [];
export const deliveryChannel = (prefix: string): string => `${prefix}:email`;
export const formatNotification = (input: NotificationInput): string =>
  `${input.orderId}:${input.ownerName}:${deliveryChannel(input.prefix)}`;
export const sendNotification = (input: NotificationInput): string => {
  const message = formatNotification(input);
  notificationLog.push(message);
  return message;
};
