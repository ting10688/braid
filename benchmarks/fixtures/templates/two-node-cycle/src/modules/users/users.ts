import { permissionName } from "../permissions/permissions.js";

export const userPermissionLabel = (user: string): string =>
  `${user}:${permissionName()}`;
