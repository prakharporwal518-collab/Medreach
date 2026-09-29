// Hospital registry for the Bhopal region (Madhya Pradesh).
//
// ⚠️ PROTOTYPE DATA: hospital names are real public landmarks, but coordinates
// are approximate and capabilities, bed counts and duty rosters are SIMULATED
// for the demo. In production this registry would be fed live by hospitals
// (through the Hospital Console / HMIS integration) and the state health
// department's facility registry (NHA Health Facility Registry).

const ALL_TERTIARY = [
  'emergency', 'icu', 'ventilator', 'cardiology', 'cath_lab', 'neurology', 'thrombolysis', 'ct_scan', 'mri',
  'trauma', 'neurosurgery', 'orthopedics', 'burns', 'obstetrics', 'nicu', 'pediatrics', 'blood_bank',
  'anti_venom', 'toxicology', 'dialysis', 'anti_rabies',
];

const beds = (icu, emergency, labour = 0) => ({
  icu: { total: icu[1], free: icu[0] },
  emergency: { total: emergency[1], free: emergency[0] },
  labour: { total: labour ? labour[1] : 0, free: labour ? labour[0] : 0 },
});

export const HOSPITALS = [
  {
    id: 'aiims-bpl', name: 'AIIMS Bhopal', nameHi: 'एम्स भोपाल', area: 'Saket Nagar, Bhopal',
    lat: 23.2078, lng: 77.4596, ownership: 'govt', level: 'tertiary', ayushman: true,
    capabilities: ALL_TERTIARY,
    status: { erStatus: 'open', beds: beds([4, 40], [9, 60], [3, 12]), erQueue: 9, erDoctors: 5, ventilatorsFree: 5,
      onDuty: ['cardiology', 'neurology', 'trauma', 'neurosurgery', 'orthopedics', 'obstetrics', 'pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 11, admissionsPerHour: { icu: 1.1, emergency: 3, labour: 0.8 }, dischargesPerHour: { icu: 0.7, emergency: 2.5, labour: 0.7 } },
  },
  {
    id: 'hamidia', name: 'Hamidia Hospital (GMC)', nameHi: 'हमीदिया अस्पताल (GMC)', area: 'Royal Market, Bhopal',
    lat: 23.2594, lng: 77.3915, ownership: 'govt', level: 'tertiary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'cardiology', 'neurology', 'ct_scan', 'mri', 'trauma', 'neurosurgery',
      'orthopedics', 'burns', 'pediatrics', 'blood_bank', 'anti_venom', 'toxicology', 'dialysis', 'anti_rabies', 'thrombolysis'],
    status: { erStatus: 'busy', beds: beds([2, 50], [6, 80]), erQueue: 18, erDoctors: 6, ventilatorsFree: 3,
      onDuty: ['cardiology', 'trauma', 'neurosurgery', 'orthopedics', 'pediatrics', 'neurology'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 16, admissionsPerHour: { icu: 1.4, emergency: 4 }, dischargesPerHour: { icu: 0.9, emergency: 3.2 } },
  },
  {
    id: 'sultania', name: 'Sultania Zanana Hospital', nameHi: 'सुल्तानिया ज़नाना अस्पताल', area: 'Sultania Road, Bhopal',
    lat: 23.2623, lng: 77.4001, ownership: 'govt', level: 'secondary', ayushman: true,
    servesOnly: 'maternity',
    capabilities: ['emergency', 'obstetrics', 'nicu', 'blood_bank', 'icu', 'pediatrics'],
    status: { erStatus: 'open', beds: beds([1, 6], [4, 20], [5, 24]), erQueue: 6, erDoctors: 3, ventilatorsFree: 0,
      onDuty: ['obstetrics', 'pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 5, admissionsPerHour: { icu: 0.2, emergency: 1, labour: 1.6 }, dischargesPerHour: { icu: 0.2, emergency: 0.8, labour: 1.4 } },
  },
  {
    id: 'kamla-nehru', name: 'Kamla Nehru Children\'s Hospital', nameHi: 'कमला नेहरू बाल चिकित्सालय', area: 'Hamidia campus, Bhopal',
    lat: 23.2605, lng: 77.3940, ownership: 'govt', level: 'tertiary', ayushman: true,
    servesOnly: 'children',
    capabilities: ['emergency', 'pediatrics', 'nicu', 'icu', 'ventilator', 'blood_bank'],
    status: { erStatus: 'open', beds: beds([3, 20], [5, 30]), erQueue: 7, erDoctors: 3, ventilatorsFree: 2,
      onDuty: ['pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 6, admissionsPerHour: { icu: 0.5, emergency: 1.5 }, dischargesPerHour: { icu: 0.4, emergency: 1.2 } },
  },
  {
    id: 'jp-hospital', name: 'JP District Hospital (1250)', nameHi: 'जेपी ज़िला अस्पताल (1250)', area: 'T.T. Nagar, Bhopal',
    lat: 23.2335, lng: 77.4013, ownership: 'govt', level: 'secondary', ayushman: true,
    capabilities: ['emergency', 'icu', 'orthopedics', 'obstetrics', 'pediatrics', 'nicu', 'blood_bank', 'anti_venom',
      'ct_scan', 'dialysis', 'anti_rabies', 'trauma'],
    status: { erStatus: 'open', beds: beds([2, 10], [8, 30], [3, 12]), erQueue: 10, erDoctors: 3, ventilatorsFree: 1,
      onDuty: ['orthopedics', 'obstetrics', 'pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 8, admissionsPerHour: { icu: 0.4, emergency: 2, labour: 0.7 }, dischargesPerHour: { icu: 0.3, emergency: 1.8, labour: 0.6 } },
  },
  {
    id: 'bmhrc', name: 'Bhopal Memorial Hospital & RC', nameHi: 'भोपाल मेमोरियल अस्पताल', area: 'Raisen Bypass, Bhopal',
    lat: 23.2960, lng: 77.4195, ownership: 'govt', level: 'tertiary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'cardiology', 'cath_lab', 'neurology', 'ct_scan', 'mri', 'neurosurgery',
      'dialysis', 'blood_bank', 'toxicology', 'thrombolysis'],
    status: { erStatus: 'open', beds: beds([5, 24], [6, 20]), erQueue: 4, erDoctors: 2, ventilatorsFree: 4,
      onDuty: ['cardiology', 'neurology'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 4, admissionsPerHour: { icu: 0.6, emergency: 1 }, dischargesPerHour: { icu: 0.5, emergency: 0.9 } },
  },
  {
    id: 'bansal', name: 'Bansal Hospital', nameHi: 'बंसल अस्पताल', area: 'Shahpura, Bhopal',
    lat: 23.2037, lng: 77.4290, ownership: 'private', level: 'tertiary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'cardiology', 'cath_lab', 'neurology', 'thrombolysis', 'ct_scan', 'mri',
      'trauma', 'neurosurgery', 'orthopedics', 'dialysis', 'blood_bank', 'toxicology', 'obstetrics', 'nicu', 'pediatrics'],
    status: { erStatus: 'open', beds: beds([3, 30], [5, 20], [2, 6]), erQueue: 3, erDoctors: 3, ventilatorsFree: 4,
      onDuty: ['cardiology', 'neurology', 'trauma', 'neurosurgery', 'orthopedics', 'obstetrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 5, admissionsPerHour: { icu: 0.7, emergency: 1.4, labour: 0.3 }, dischargesPerHour: { icu: 0.5, emergency: 1.2, labour: 0.3 } },
  },
  {
    id: 'chirayu', name: 'Chirayu Medical College & Hospital', nameHi: 'चिरायु मेडिकल कॉलेज', area: 'Bhainsakhedi, Bhopal',
    lat: 23.2790, lng: 77.3240, ownership: 'private', level: 'tertiary', ayushman: true,
    capabilities: ALL_TERTIARY.filter((c) => c !== 'thrombolysis'),
    status: { erStatus: 'open', beds: beds([6, 40], [7, 30], [3, 10]), erQueue: 5, erDoctors: 3, ventilatorsFree: 5,
      onDuty: ['cardiology', 'trauma', 'orthopedics', 'obstetrics', 'pediatrics', 'neurosurgery'], equipmentDown: ['cath_lab'] },
    stats: { erArrivalsPerHour: 6, admissionsPerHour: { icu: 0.8, emergency: 1.5, labour: 0.5 }, dischargesPerHour: { icu: 0.6, emergency: 1.3, labour: 0.4 } },
  },
  {
    id: 'peoples', name: 'People\'s Hospital', nameHi: 'पीपुल्स अस्पताल', area: 'Bhanpur, Bhopal',
    lat: 23.3080, lng: 77.4280, ownership: 'private', level: 'tertiary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'cardiology', 'neurology', 'ct_scan', 'mri', 'trauma', 'neurosurgery',
      'orthopedics', 'burns', 'obstetrics', 'nicu', 'pediatrics', 'blood_bank', 'anti_venom', 'toxicology', 'dialysis'],
    status: { erStatus: 'open', beds: beds([4, 30], [6, 25], [2, 8]), erQueue: 4, erDoctors: 2, ventilatorsFree: 3,
      onDuty: ['trauma', 'orthopedics', 'obstetrics', 'pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 5, admissionsPerHour: { icu: 0.6, emergency: 1.3, labour: 0.4 }, dischargesPerHour: { icu: 0.5, emergency: 1.1, labour: 0.4 } },
  },
  {
    id: 'narmada-trauma', name: 'Narmada Trauma Centre', nameHi: 'नर्मदा ट्रॉमा सेंटर', area: 'Hoshangabad Road, Bhopal',
    lat: 23.2270, lng: 77.4340, ownership: 'private', level: 'secondary', ayushman: false,
    capabilities: ['emergency', 'icu', 'ventilator', 'trauma', 'neurosurgery', 'orthopedics', 'ct_scan', 'blood_bank'],
    status: { erStatus: 'open', beds: beds([2, 12], [3, 10]), erQueue: 2, erDoctors: 2, ventilatorsFree: 2,
      onDuty: ['trauma', 'neurosurgery', 'orthopedics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 3, admissionsPerHour: { icu: 0.4, emergency: 0.8 }, dischargesPerHour: { icu: 0.3, emergency: 0.7 } },
  },
  {
    id: 'siddhanta', name: 'Siddhanta Red Cross Hospital', nameHi: 'सिद्धांता रेड क्रॉस अस्पताल', area: 'Shivaji Nagar, Bhopal',
    lat: 23.2290, lng: 77.4160, ownership: 'private', level: 'secondary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'cardiology', 'cath_lab', 'ct_scan', 'dialysis'],
    status: { erStatus: 'open', beds: beds([1, 10], [3, 10]), erQueue: 2, erDoctors: 1, ventilatorsFree: 1,
      onDuty: ['cardiology'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 2, admissionsPerHour: { icu: 0.3, emergency: 0.6 }, dischargesPerHour: { icu: 0.2, emergency: 0.5 } },
  },
  {
    id: 'civil-bairagarh', name: 'Civil Hospital Bairagarh', nameHi: 'सिविल अस्पताल बैरागढ़', area: 'Bairagarh, Bhopal',
    lat: 23.2690, lng: 77.3350, ownership: 'govt', level: 'primary', ayushman: true,
    capabilities: ['emergency', 'obstetrics', 'anti_venom', 'anti_rabies', 'pediatrics'],
    status: { erStatus: 'open', beds: beds([0, 0], [4, 8], [2, 4]), erQueue: 3, erDoctors: 1, ventilatorsFree: 0,
      onDuty: ['obstetrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 2, admissionsPerHour: { emergency: 0.5, labour: 0.3 }, dischargesPerHour: { emergency: 0.4, labour: 0.3 } },
  },
  {
    id: 'chc-berasia', name: 'CHC Berasia', nameHi: 'सामुदायिक स्वास्थ्य केंद्र बैरसिया', area: 'Berasia, Bhopal district',
    lat: 23.6330, lng: 77.4340, ownership: 'govt', level: 'primary', ayushman: true,
    capabilities: ['emergency', 'obstetrics', 'anti_venom', 'anti_rabies'],
    status: { erStatus: 'open', beds: beds([0, 0], [3, 6], [2, 4]), erQueue: 2, erDoctors: 1, ventilatorsFree: 0,
      onDuty: ['obstetrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 1.5, admissionsPerHour: { emergency: 0.4, labour: 0.3 }, dischargesPerHour: { emergency: 0.3, labour: 0.3 } },
  },
  {
    id: 'dh-sehore', name: 'District Hospital Sehore', nameHi: 'ज़िला अस्पताल सीहोर', area: 'Sehore',
    lat: 23.2010, lng: 77.0850, ownership: 'govt', level: 'secondary', ayushman: true,
    capabilities: ['emergency', 'icu', 'obstetrics', 'nicu', 'pediatrics', 'anti_venom', 'blood_bank', 'orthopedics', 'anti_rabies', 'ct_scan'],
    status: { erStatus: 'open', beds: beds([2, 8], [5, 20], [3, 10]), erQueue: 5, erDoctors: 2, ventilatorsFree: 1,
      onDuty: ['obstetrics', 'pediatrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 4, admissionsPerHour: { icu: 0.3, emergency: 1, labour: 0.6 }, dischargesPerHour: { icu: 0.2, emergency: 0.9, labour: 0.5 } },
  },
  {
    id: 'dh-raisen', name: 'District Hospital Raisen', nameHi: 'ज़िला अस्पताल रायसेन', area: 'Raisen',
    lat: 23.3310, lng: 77.7840, ownership: 'govt', level: 'secondary', ayushman: true,
    capabilities: ['emergency', 'icu', 'obstetrics', 'nicu', 'pediatrics', 'anti_venom', 'blood_bank', 'anti_rabies'],
    status: { erStatus: 'open', beds: beds([1, 6], [4, 15], [2, 8]), erQueue: 4, erDoctors: 2, ventilatorsFree: 1,
      onDuty: ['obstetrics'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 3, admissionsPerHour: { icu: 0.2, emergency: 0.8, labour: 0.5 }, dischargesPerHour: { icu: 0.2, emergency: 0.7, labour: 0.4 } },
  },
  {
    id: 'gmc-vidisha', name: 'Atal Bihari Vajpayee GMC Vidisha', nameHi: 'अटल बिहारी वाजपेयी GMC विदिशा', area: 'Vidisha',
    lat: 23.5100, lng: 77.8050, ownership: 'govt', level: 'tertiary', ayushman: true,
    capabilities: ['emergency', 'icu', 'ventilator', 'ct_scan', 'obstetrics', 'nicu', 'pediatrics', 'orthopedics', 'trauma',
      'anti_venom', 'blood_bank', 'burns', 'toxicology', 'anti_rabies', 'neurology'],
    status: { erStatus: 'open', beds: beds([3, 20], [6, 30], [3, 12]), erQueue: 6, erDoctors: 3, ventilatorsFree: 2,
      onDuty: ['obstetrics', 'pediatrics', 'orthopedics', 'trauma'], equipmentDown: [] },
    stats: { erArrivalsPerHour: 5, admissionsPerHour: { icu: 0.5, emergency: 1.4, labour: 0.7 }, dischargesPerHour: { icu: 0.4, emergency: 1.2, labour: 0.6 } },
  },
];

// Minutes since each hospital's figures were last verified (seed for the demo),
// so all three freshness levels are visible: 🟢 < 15 min, 🟡 15–60, 🔴 > 60.
export const SEED_VERIFIED_MIN_AGO = {
  'aiims-bpl': 3, hamidia: 28, sultania: 6, 'kamla-nehru': 9, 'jp-hospital': 22, bmhrc: 4, bansal: 2,
  chirayu: 11, peoples: 190, 'narmada-trauma': 5, siddhanta: 35, 'civil-bairagarh': 80, 'chc-berasia': 140,
  'dh-sehore': 12, 'dh-raisen': 47, 'gmc-vidisha': 8,
};

// SIMULATED ambulance fleet, modelled on MP's 108 / Janani Express services.
// The prototype does NOT dispatch real 108 vehicles; in deployment the
// transport layer hands requests to the authorised 108 control room (CAD).
export const AMBULANCES = [
  { id: '108-ALS-01', type: 'ALS', base: 'Hamidia Road', lat: 23.2570, lng: 77.3990 },
  { id: '108-ALS-02', type: 'ALS', base: 'MP Nagar', lat: 23.2330, lng: 77.4340 },
  { id: '108-BLS-03', type: 'BLS', base: 'Kolar Road', lat: 23.1750, lng: 77.4180 },
  { id: '108-BLS-04', type: 'BLS', base: 'Bairagarh', lat: 23.2700, lng: 77.3370 },
  { id: 'JE-05', type: 'JANANI', base: 'Govindpura', lat: 23.2560, lng: 77.4480 },
  { id: '108-BLS-06', type: 'BLS', base: 'Berasia', lat: 23.6320, lng: 77.4320 },
  { id: '108-ALS-07', type: 'ALS', base: 'Sehore', lat: 23.2030, lng: 77.0870 },
  { id: '108-BLS-08', type: 'BLS', base: 'Raisen', lat: 23.3300, lng: 77.7820 },
  { id: '108-ALS-09', type: 'ALS', base: 'Vidisha', lat: 23.5250, lng: 77.8080 },
];

// A sensible demo location (New Market, Bhopal) for when GPS is unavailable
// or the user is outside the covered region.
export const DEMO_LOCATION = { lat: 23.2355, lng: 77.4005, label: 'New Market, Bhopal (demo)' };
