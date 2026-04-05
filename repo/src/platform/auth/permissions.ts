import type { UserRole } from '../db/schema';

export const permissions = {
  auth: {
    login: 'auth.login',
    logout: 'auth.logout',
    me: 'auth.me',
    permissions: 'auth.permissions'
  },
  catalog: {
    manage: 'catalog.manage'
  },
  promotions: {
    manage: 'promotions.manage'
  },
  pricing: {
    managePolicies: 'pricing.manage_policies'
  },
  courses: {
    manageSchedules: 'courses.manage_schedules'
  },
  attendance: {
    record: 'attendance.record'
  },
  sales: {
    createOrders: 'sales.create_orders',
    applyVouchers: 'sales.apply_vouchers'
  },
  charging: {
    manage: 'charging.manage'
  },
  reconciliation: {
    manage: 'reconciliation.manage'
  },
  audit: {
    readLogs: 'audit.read_logs',
    readReconciliationExports: 'audit.read_reconciliation_exports'
  }
} as const;

export const permissionValues = [
  permissions.auth.login,
  permissions.auth.logout,
  permissions.auth.me,
  permissions.auth.permissions,
  permissions.catalog.manage,
  permissions.promotions.manage,
  permissions.pricing.managePolicies,
  permissions.courses.manageSchedules,
  permissions.attendance.record,
  permissions.sales.createOrders,
  permissions.sales.applyVouchers,
  permissions.charging.manage,
  permissions.reconciliation.manage,
  permissions.audit.readLogs,
  permissions.audit.readReconciliationExports
] as const;

export type Permission = (typeof permissionValues)[number];

const allAuthPermissions: Permission[] = [
  permissions.auth.login,
  permissions.auth.logout,
  permissions.auth.me,
  permissions.auth.permissions
];

export const rolePermissionMatrix: Record<UserRole, Permission[]> = {
  administrator: [
    ...allAuthPermissions,
    permissions.catalog.manage,
    permissions.promotions.manage,
    permissions.pricing.managePolicies,
    permissions.charging.manage,
    permissions.reconciliation.manage
  ],
  operations_manager: [...allAuthPermissions, permissions.courses.manageSchedules, permissions.charging.manage],
  proctor: [...allAuthPermissions, permissions.attendance.record],
  instructor: [...allAuthPermissions, permissions.attendance.record],
  sales_associate: [
    ...allAuthPermissions,
    permissions.sales.createOrders,
    permissions.sales.applyVouchers,
    permissions.charging.manage
  ],
  auditor: [...allAuthPermissions, permissions.audit.readLogs, permissions.audit.readReconciliationExports]
};

export const roleHasPermission = (role: UserRole, permission: Permission): boolean =>
  rolePermissionMatrix[role]?.includes(permission) ?? false;
