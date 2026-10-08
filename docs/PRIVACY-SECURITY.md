# Medreach – Privacy & Security by Design

Medreach handles sensitive data: location, emergency descriptions, patient identity, ABHA / Ayushman numbers, allergies and health documents. This page describes what is **implemented in the prototype** and what is **designed for deployment**.

## 1. Data we handle and who can see it

| Data | Citizen device | Receiving hospital | Trusted contact | Stored on server |
|---|---|---|---|---|
| Emergency description (raw text) | ✅ | ❌ (gets a clinical summary instead) | ❌ | Until retention purge |
| Emergency type / severity | ✅ | ✅ | Label only | ✅ |
| Location | ✅ | ✅, rounded to about 100 m | ✅ (to find them) | Until purge, then rounded to about 1 km |
| Patient details from a scanned card | ✅ | **Only with explicit consent** | ❌ | Only with consent |
| ABHA / Ayushman number | ✅ | Masked `••••1203` | ❌ | Only with consent |
| Photo of injury | ✅ (on-device) | Text description only | ❌ | **Never stored** (only the description) |
| Health-card image (OCR) | ✅ (read on the phone) | ❌ | ❌ | **Never uploaded** |
| Trusted contact phone | ✅ (saved locally) | ❌ | – | Masked in logs, deleted at purge |

## 2. Implemented in the prototype

| Principle | How | Code |
|---|---|---|
| **Minimum data collection** | Only the emergency summary and location are needed. Patient details are optional. | `public/js/app.js` `requestHospital` |
| **Consent before sharing** | "What will be shared" card. Patient details are sent only if the consent box is ticked. The server drops them otherwise. | `app.js`, `server/store.js` `createCase` |
| **On-device processing** | OCR (Tesseract.js) and the offline photo check run in the browser. | `public/js/ocr.js`, `public/js/vision.js` |
| **Masked identifiers** | Hospitals see ABHA/Ayushman as `••••1234`; phone numbers are masked in logs. | `store.js` `hospitalView` |
| **Hospital-specific access** | A case is visible only to the hospital the referral is currently addressed to. Access ends when it moves on. | `server/api.js` dashboard route |
| **Case ownership** | The creating device gets a random case token; every case call requires it. | `api.js` `caseFor` |
| **Limited family view** | A separate read-only track token shows status, hospital and ETA only. | `store.js` `trackView` |
| **Staff authentication** | Hospital ID + Staff ID + 6-digit OTP (5 min, single use, max 5 attempts). The same response is given for unknown IDs, so staff IDs can't be probed. | `server/auth.js` |
| **Role-based access** | Nodal Officer / Emergency Desk / Resource Manager / State Admin, enforced on the server and reflected in the UI. | `shared/roles.js`, `api.js` |
| **Session scope** | 8-hour sessions bound to one hospital; cross-hospital actions return 403 and are logged. | `auth.js` `require` |
| **Audit trail** | Every login, OTP request, status change (with before → after), referral decision and denied access is recorded with who, role and time. Entries are hash-chained (SHA-256), so any edit, deletion or reordering is detected; the audit page shows the check. | `store.js` `audit`, `verifyAudit` |
| **Citizen identity** | Aadhaar + OTP to the Aadhaar-linked mobile, with consent. The Aadhaar number is never stored: only a keyed HMAC reference and the last 4 digits. OTP limits and lockout. Simulated UIDAI in demo mode. | `server/citizen-auth.js`, `shared/aadhaar.js` |
| **Integrations** | 108 control room and SMS gateway requests are HMAC-SHA256 signed with a 5-minute replay window; the incident sent to 108 carries no Aadhaar/ABHA numbers and no names without consent. | `server/ems.js`, `server/sms.js` |
| **Session secrets** | Staff session tokens are stored only as SHA-256 hashes; citizen sessions are HMAC-signed tokens. | `auth.js`, `citizen-auth.js` |
| **Retention / auto-expiry** | 24 h after hand-over: patient details, raw text, contact, photo description and handover note are deleted, and location is coarsened. | `store.js` `purge` |
| **Honest labelling** | DEMO banner; "simulated" on ambulance and simulated hospital responses; data source on every figure. | UI |
| **Basic hardening** | `nosniff`, `no-referrer`, `SAMEORIGIN`, no `x-powered-by`, JSON size limit, HTML escaping of all user text. | `server/index.js` |

Tests cover consent, masking, the track view, token checks, RBAC, OTP brute-force limits and the retention purge (`tests/api.test.js`, `tests/freshness.test.js`).

## 3. Designed for deployment

- **Encryption in transit:** HTTPS/TLS 1.2+ everywhere, with HSTS.
- **Encryption at rest:** encrypted Postgres (disk and column-level for health fields); keys in a KMS; hosting in India (MeitY-empanelled cloud).
- **Identity:** citizens: Aadhaar OTP through a licensed AUA/KUA (or DigiLocker / ABHA login), with an Aadhaar Data Vault if numbers ever need to be kept; staff registry synced with hospital HR / state records; SMS OTP via a government SMS gateway; optional device binding; admin approval for new staff.
- **ABDM integration:** fetch ABHA-linked records only through the ABDM consent manager, instead of scanning cards.
- **DPDP Act 2023:** a notice in Hindi and English, purpose limitation (emergency care only), rights to access and erasure, a Data Protection Impact Assessment, and breach reporting.
- **Operational security:** rate limiting, WAF, centralised tamper-evident audit logs, periodic access reviews, and a penetration test before go-live.
- **AI data handling:** only the minimum text is sent to the model; no ID numbers; zero-retention API settings where available.
