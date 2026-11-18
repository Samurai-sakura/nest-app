export const ADMIN_ROLE = "admin";
export const USER_ROLE = "user";

// разрешения и их действия, которые создаёт начальная загрузка
export const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  rbac: ["manage"],
  users: ["read", "read_any", "update", "update_any", "delete", "delete_any", "list"],
};

// роль → разрешение → действия; пустой список означает все текущие и будущие действия
export const DEFAULT_ROLES: Record<string, Record<string, string[]>> = {
  [USER_ROLE]: { users: ["read", "update", "delete"] },
  [ADMIN_ROLE]: { rbac: ["manage"], users: [] },
};
