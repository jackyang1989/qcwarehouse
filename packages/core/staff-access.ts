export const staffAccess = {
  administration: ["super_admin","support","finance","template_admin"],
  orders: ["super_admin","support"],
  finance: ["super_admin","finance"],
  templates: ["super_admin","template_admin"],
  intake: ["receiver","warehouse_admin","super_admin"],
  locations: ["super_admin"],
  inspection: ["inspector","reviewer","super_admin"],
  reportEditing: ["reviewer","warehouse_admin","super_admin"],
  dispatch: ["warehouse_admin","super_admin"],
  tracking: ["warehouse_admin","receiver","support","super_admin"],
  trackingConfiguration: ["super_admin"],
} as const;

export function hasStaffAccess(roles: readonly string[], allowed: readonly string[]) {
  return allowed.some(role=>roles.includes(role));
}
