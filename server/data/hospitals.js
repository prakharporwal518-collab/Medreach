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
  chirayu: 11, peoples: 190, 'narmada-trauma': 5, siddhanta: 35, 'civil-bairagarh': 100, 'chc-berasia': 140,
  'dh-sehore': 12, 'dh-raisen': 112, 'gmc-vidisha': 8,
};

// SIMULATED ambulance fleet, modelled on MP's 108 / Janani Express services:
// 5–6 units stationed in every service area (ALS = advanced life support,
// BLS = basic life support, JANANI = Janani Express for mothers & newborns).
// The prototype does NOT dispatch real 108 vehicles; in deployment the
// transport layer hands requests to the authorised 108 control room (CAD).
const unit = (id, type, base, lat, lng) => ({ id, type, base, lat, lng });
export const AMBULANCE_AREAS = [
  { area: 'Bhopal – Old City', units: [
    unit('108-ALS-01', 'ALS', 'Hamidia Road', 23.2570, 77.3990),
    unit('108-ALS-10', 'ALS', 'Peer Gate', 23.2640, 77.4045),
    unit('108-BLS-11', 'BLS', 'Nadra Bus Stand', 23.2655, 77.3955),
    unit('108-BLS-12', 'BLS', 'Shahjahanabad', 23.2710, 77.3925),
    unit('108-BLS-13', 'BLS', 'Karond', 23.3010, 77.4040),
    unit('JE-14', 'JANANI', 'Sultania Road', 23.2625, 77.4010),
  ] },
  { area: 'Bhopal – Central', units: [
    unit('108-ALS-02', 'ALS', 'MP Nagar', 23.2330, 77.4340),
    unit('108-ALS-15', 'ALS', 'TT Nagar', 23.2345, 77.3995),
    unit('108-BLS-16', 'BLS', 'New Market', 23.2360, 77.4015),
    unit('108-BLS-17', 'BLS', 'Shivaji Nagar', 23.2290, 77.4140),
    unit('108-BLS-18', 'BLS', 'Arera Colony', 23.2125, 77.4330),
    unit('JE-19', 'JANANI', 'Habibganj', 23.2250, 77.4390),
  ] },
  { area: 'Bhopal – South', units: [
    unit('108-BLS-03', 'BLS', 'Kolar Road', 23.1750, 77.4180),
    unit('108-ALS-20', 'ALS', 'Shahpura', 23.2010, 77.4225),
    unit('108-ALS-21', 'ALS', 'Misrod', 23.1720, 77.4720),
    unit('108-BLS-22', 'BLS', 'Bawadiya Kalan', 23.1860, 77.4480),
    unit('108-BLS-23', 'BLS', 'Chuna Bhatti', 23.1950, 77.4070),
    unit('JE-24', 'JANANI', 'Danish Kunj', 23.1660, 77.4100),
  ] },
  { area: 'Bhopal – West', units: [
    unit('108-BLS-04', 'BLS', 'Bairagarh', 23.2700, 77.3370),
    unit('108-ALS-25', 'ALS', 'Bhainsakhedi', 23.2790, 77.3290),
    unit('108-ALS-26', 'ALS', 'Lalghati', 23.2830, 77.3800),
    unit('108-BLS-27', 'BLS', 'Kohefiza', 23.2600, 77.3720),
    unit('108-BLS-28', 'BLS', 'Neelbad', 23.2150, 77.3500),
    unit('JE-29', 'JANANI', 'Gandhi Nagar', 23.2930, 77.3420),
  ] },
  { area: 'Bhopal – East', units: [
    unit('JE-05', 'JANANI', 'Govindpura', 23.2560, 77.4480),
    unit('108-ALS-30', 'ALS', 'BHEL Piplani', 23.2560, 77.4690),
    unit('108-ALS-31', 'ALS', 'Ayodhya Bypass', 23.2830, 77.4580),
    unit('108-BLS-32', 'BLS', 'Bhanpur', 23.3080, 77.4280),
    unit('108-BLS-33', 'BLS', 'Ashoka Garden', 23.2550, 77.4300),
    unit('108-BLS-34', 'BLS', 'Anand Nagar', 23.2600, 77.4800),
  ] },
  { area: 'Berasia', units: [
    unit('108-BLS-06', 'BLS', 'Berasia', 23.6320, 77.4320),
    unit('108-ALS-35', 'ALS', 'Berasia CHC', 23.6330, 77.4340),
    unit('108-BLS-36', 'BLS', 'Nazirabad', 23.5620, 77.3940),
    unit('108-BLS-37', 'BLS', 'Gunga', 23.5450, 77.5100),
    unit('JE-38', 'JANANI', 'Berasia Bus Stand', 23.6290, 77.4290),
  ] },
  { area: 'Sehore', units: [
    unit('108-ALS-07', 'ALS', 'Sehore', 23.2030, 77.0870),
    unit('108-ALS-39', 'ALS', 'Bhopal Naka, Sehore', 23.2100, 77.1000),
    unit('108-BLS-40', 'BLS', 'Sehore Bus Stand', 23.2000, 77.0820),
    unit('108-BLS-41', 'BLS', 'Ashta Road', 23.1950, 77.1000),
    unit('JE-42', 'JANANI', 'Ichhawar Road', 23.1900, 77.0750),
  ] },
  { area: 'Raisen', units: [
    unit('108-BLS-08', 'BLS', 'Raisen', 23.3300, 77.7820),
    unit('108-ALS-43', 'ALS', 'Raisen Bus Stand', 23.3330, 77.7880),
    unit('108-BLS-44', 'BLS', 'Diwanganj', 23.3720, 77.6830),
    unit('108-BLS-45', 'BLS', 'Salamatpur', 23.4580, 77.7330),
    unit('JE-46', 'JANANI', 'Raisen Fort Road', 23.3280, 77.7750),
  ] },
  { area: 'Vidisha', units: [
    unit('108-ALS-09', 'ALS', 'Vidisha', 23.5250, 77.8080),
    unit('108-ALS-47', 'ALS', 'Bareth Road', 23.5150, 77.8200),
    unit('108-BLS-48', 'BLS', 'Vidisha Bus Stand', 23.5280, 77.8150),
    unit('108-BLS-49', 'BLS', 'Sanchi', 23.4800, 77.7400),
    unit('JE-50', 'JANANI', 'Durga Nagar', 23.5300, 77.7990),
  ] },
];
export const AMBULANCES = AMBULANCE_AREAS.flatMap(({ area, units }) => units.map((u) => ({ ...u, area })));

// A sensible demo location (New Market, Bhopal) for when GPS is unavailable
// or the user is outside the covered region.
export const DEMO_LOCATION = { lat: 23.2355, lng: 77.4005, label: 'New Market, Bhopal (demo)' };
