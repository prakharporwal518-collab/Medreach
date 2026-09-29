// Authorised hospital staff (FICTIONAL people for the prototype).
// In production this comes from the hospital's HR / state health staff
// registry, and OTPs go to the registered mobile via an SMS gateway.

import { HOSPITALS } from './hospitals.js';

const NAMES = [
  ['Dr. Anjali Verma', 'Rakesh Yadav', 'Sunita Patel'],
  ['Dr. Imran Qureshi', 'Pooja Sharma', 'Vikas Tiwari'],
  ['Dr. Meera Joshi', 'Arun Chouhan', 'Kavita Rathore'],
  ['Dr. Sandeep Mishra', 'Neha Dubey', 'Manoj Solanki'],
];

// Staff ID pattern: <HOSPITAL-ID>-NO01 (Nodal Officer), -ED01 (Emergency Desk), -RM01 (Resource Manager)
export const STAFF = [
  ...HOSPITALS.flatMap((h, i) => {
    const [no, ed, rm] = NAMES[i % NAMES.length];
    const p = h.id.toUpperCase();
    const mobile = (n) => `9${String(800000000 + i * 1000 + n).padStart(9, '0')}`;
    return [
      { staffId: `${p}-NO01`, hospitalId: h.id, name: no, role: 'nodal_officer', mobile: mobile(1) },
      { staffId: `${p}-ED01`, hospitalId: h.id, name: ed, role: 'emergency_desk', mobile: mobile(2) },
      { staffId: `${p}-RM01`, hospitalId: h.id, name: rm, role: 'resource_manager', mobile: mobile(3) },
    ];
  }),
  { staffId: 'MP-ADMIN-01', hospitalId: 'MP-STATE', name: 'State Health Control Room', role: 'admin', mobile: '9812345670' },
];
