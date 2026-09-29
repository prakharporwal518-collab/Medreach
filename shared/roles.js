// Hospital staff roles and what each may do (role-based access control).
// The server enforces these; the console uses them to show/disable controls.

export const ROLES = {
  nodal_officer: {
    label: 'Hospital Nodal Officer',
    can: ['cases.view', 'referral.respond', 'status.er', 'status.beds', 'status.duty', 'status.equipment', 'status.verify', 'audit.view'],
  },
  emergency_desk: {
    label: 'Emergency Desk Officer',
    can: ['cases.view', 'referral.respond', 'status.er', 'status.verify'],
  },
  resource_manager: {
    label: 'Resource Manager',
    can: ['cases.view', 'status.er', 'status.beds', 'status.duty', 'status.equipment', 'status.verify'],
  },
  admin: {
    label: 'State Health Admin',
    can: ['cases.view', 'audit.view'],
    allHospitals: true, // read-only oversight across hospitals
  },
};

export function roleLabel(role) {
  return ROLES[role]?.label || role;
}

/** May this staff member perform `action` on `hospitalId`? */
export function can(staff, action, hospitalId) {
  const role = ROLES[staff?.role];
  if (!role || !role.can.includes(action)) return false;
  return role.allHospitals || staff.hospitalId === hospitalId;
}
