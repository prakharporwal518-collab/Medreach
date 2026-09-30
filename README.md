# 🚑 Sehat Setu – सेहत सेतु

**Challenge 5 · AI Innovation for Public Services & Citizen-Centric Governance · Domain: Healthcare**
MPOnline Idea & Innovation Hackathon 2026

> In a medical emergency, families usually rush to the *nearest* hospital, only to find there is no cardiologist on duty, the CT scanner is down, or the ICU is full. They then lose the golden hour driving to a second hospital.
>
> **Sehat Setu is an emergency *coordination* platform, not a diagnosis app.** It gets the patient to a hospital that can treat them, and that has **accepted** them, before they leave home.

### Our USP

**Emergency → Understand → Match → Verify → Accept → Transport → Confirm**

| # | Feature | What makes it credible |
|---|---|---|
| 1 | 🤖 **AI emergency understanding** | Natural language (Hindi, English, Hinglish, voice) → structured requirements. It says *"this may indicate…"*, never *"you have…"*. |
| 2 | 🏥 **Capability-based matching** | Not the nearest hospital, but one where the service exists, the specialist is on duty **now** and the machine works **now**. |
| 3 | 📊 **Current resource status** | Beds, ICU, ER open/busy/diverting, equipment and duty roster, entered by **authorised hospital staff**. |
| 4 | ⏱️ **Freshness** | 🟢 *Verified 2 min ago* · 🟡 *Verified 28 min ago – may have changed* · 🔴 *Availability unverified*. Stale data is never shown as confirmed. |
| 5 | 📞 **Hospital acceptance** | A named staff member accepts the referral and assigns a receiving bay **before** the patient travels. |
| 6 | 🔄 **Automatic fallback** | Decline or no response → the next suitable hospital is asked automatically. |
| 7 | 🚑 **Transport + confirmed destination** | Ambulance request (simulated in the prototype) or own vehicle → navigation → confirmed hospital. |

---

## ▶️ See it instantly: one HTML file

Download **[`demo/sehat-setu-prototype.html`](demo/sehat-setu-prototype.html)** and double-click it. There's no install and no server.
You get the citizen app in a phone frame next to the hospital console.
- Keep **"I'll act as the hospital desk"** ticked: the console logs in as the receiving hospital's Emergency Desk Officer (real OTP flow, demo OTP), and you accept the referral yourself.
- Untick it: the ER desk is simulated.

It runs the same app, API, auth and store code as the full server version, just inside the page.

## Run the full version

```bash
npm install
npm start            # http://localhost:3000
npm test             # 51 tests
npm run build:demo   # regenerate the single-file demo
```

| Page | URL | Who | Login |
|---|---|---|---|
| Home page | `/` | Everyone | – |
| Report emergency | `/report` | Anyone in an emergency | **None needed** (signed-in citizens get their details pre-filled) |
| Sign in / register | `/login` | Citizen · Hospital Staff · Health Admin | Role cards, like a portal account screen |
| Citizen dashboard | `/citizen` | Patients & families | Citizen account (mobile + password). **Report Emergency** opens the voice emergency app *inside* the dashboard (`/citizen#emergency`) |
| Hospital dashboard | `/hospital` | Authorised hospital staff | Hospital ID + Staff ID + OTP |

### Two separate portals, private from each other
- **Citizen portal:** the account, health records, emergency contacts and case list are stored **only on the citizen's device**. The password is stored only as a salted PBKDF2 hash. The server never holds a citizen profile. Cases are followed through the read-only tracking token (status, hospital and ETA only).
- **Hospital portal:** the server-issued staff session is kept **per browser tab** (sessionStorage) and is bound to one hospital. Roles are enforced by the server, and every action is audit-logged.
- **Neither portal can see into the other.** Opening `/citizen` without a citizen login redirects to sign-in, and opening `/hospital` without a staff session shows the staff sign-in gate. Staff see a patient's identity only if the family consented when raising the emergency, with IDs masked, and only for referrals sent to their hospital.
- Staff accounts can't be self-registered, so nobody can pose as a hospital.

### 🗺️ Live emergency maps
Every dashboard page that deals with a place has a **LIVE** map. Markers move and change colour in place as updates stream in (SSE), without redrawing the map.

| Where | What it shows live |
|---|---|
| Citizen · Home, Nearby Hospitals | You, hospitals coloured by ER status (open / busy / full) with free ICU beds, and your active case |
| Citizen · My Cases, Ambulance | Pick-up point, accepting hospital and the **ambulance moving** along its route |
| Hospital · Dashboard, Emergency Cases, Patient Queue | This hospital, nearby hospitals' public status, incoming patients and their ambulance or own vehicle with live ETA |
| Hospital · case details | The patient's pick-up point and vehicle for that one case |

- The citizen map shows the real ambulance position only in the browser tab that raised the case. The case token is handed over in that tab's `sessionStorage` and is never saved to `localStorage`. On other devices the position is estimated from the ETA and labelled "estimated position".
- Pick-up points reach hospitals rounded to about 100 m.
- Map tiles come from CARTO (OpenStreetMap data), falling back to openstreetmap.org. The server sends `Referrer-Policy: no-referrer`, so each tile request sets its own referrer policy; OpenStreetMap refuses tile requests that carry no referrer. If tiles are blocked on a network, the pins still work on a plain grid.

Optional Generative AI: `export ANTHROPIC_API_KEY=...` before `npm start`. Everything works without it.

---

## ☁️ Deploy on Render

One click: **New → Blueprint** → select this repo. [`render.yaml`](render.yaml) sets the build and start commands, the health check and all environment variables. Only `ANTHROPIC_API_KEY` is asked for, and it's optional.
Manual: **New → Web Service** with build command `npm ci`, start command `npm start`, health check `/api/config`, plus the variables in `render.yaml`. Render provides `PORT` itself.
Keep it to **one instance**, because cases and live updates are held in memory. On the free plan the service sleeps after 15 minutes idle and forgets open cases when it restarts. That's fine for a demo; open the URL a minute before presenting.

## 🟨 Demo mode vs. real deployment (what is and isn't real)

We state this plainly, in the app (yellow **DEMO** banner) and here:

| Part | In this prototype (**demo mode**) | In a real deployment (**live mode**) |
|---|---|---|
| Hospital list & locations | Real Bhopal-region hospital names; approximate coordinates | NHA Health Facility Registry (HFR) / state facility master |
| Beds, ER status, duty roster, equipment | **Simulated seed values**, labelled *"Data source: Simulated demo data"* | Entered by authorised staff on the **Hospital Emergency Dashboard**, or synced from hospital HMIS via API |
| "Verified N min ago" | Seed times vary so all 🟢/🟡/🔴 levels are visible; any staff update re-verifies | Only staff updates/confirmations verify data |
| Hospital acceptance | Real flow when staff are logged in; **simulated** desk when nobody is logged in | Always a logged-in staff member |
| Staff & OTP | Fictional staff; OTP shown on screen (no SMS gateway) | Staff registry + SMS OTP; OTP is never returned by the API (`SEHAT_DATA_MODE=live`) |
| Ambulance | **Simulated** units and movement | Hand-off to the authorised **108 / ambulance control room (CAD)**. Sehat Setu does not control 108 |
| Trusted-contact SMS | Simulated (logged + WhatsApp share link) | SMS gateway |
| AI | Offline rules engine; Claude when a key is set | Claude (with the rules engine as floor and fallback) |

**Proving the architecture live:** log in to the console as a hospital's staff and set the ER to *Diverting*. Every citizen currently looking at hospital options sees *"Live update from hospital dashboard"*, and that hospital disappears from their list within a second. Re-open it and it comes back, now showing *"🟢 Verified just now"* with *"Updated by: Emergency Desk Officer"*.

---

## 🎤 Judge Q&A: honest, short answers

**"Where exactly is the AI?"**
AI/NLP turns the citizen's words into structured requirements: emergency type, severity, red flags, age group and required capabilities. Then a **deterministic matching engine** applies those requirements to staff-verified facility data. *"AI understands the citizen's description; the final hospital selection is constrained by explicit healthcare requirements and verified facility data."* The AI never picks the hospital. The app shows this pipeline under **"How was this decided?"**.
- With an API key, Claude does the understanding (`server/llm.js`) and can only **raise** urgency, never lower it (severity = max of AI and rules).
- Without a key, or offline, the rules engine (`shared/triage.js`) is the floor.

**"Are these real-time hospital beds?"**
**No, not in the prototype.** The figures are simulated and labelled so. What's real is the architecture: authorised staff update the dashboard, every figure carries *who / when / source*, freshness is enforced, and a change reaches citizens instantly. See the table above for the live-deployment data sources.

**"Where does hospital information come from?"**
Every hospital card shows *Data source* (Hospital Emergency Dashboard or Simulated demo data), *Last verified* and *Updated by* (role).

**"What does 'Match score 92' mean?"**
Each card first shows a **"Why this hospital?"** checklist (required capability ✅, ER open ✅, ICU capacity reported ✅, recently verified ✅, referral status ⏳, ETA 🚑). The score comes second, and tapping it shows its parts:
- time to care (travel + ER wait)
- bed likely free on arrival × data freshness
- extra helpful services
- facility level

The parts always add up to the total (this is tested).

**"2 ICU beds available: so the patient is admitted?"**
No. The app keeps three things separate:
- **📊 Reported capacity:** what the hospital last reported, with time and source. *"Not a guarantee of admission."*
- **📨 Referral status:** PENDING → ACCEPTED by *Emergency Desk Officer (name)* at *time*.
- **📍 Confirmed destination:** only after acceptance, with the **receiving bay** (e.g. Resus-02).

**"Does your app dispatch 108?"**
No. *"In the prototype, ambulance dispatch is simulated. In deployment, the transport layer would integrate with the authorised emergency/ambulance service rather than independently claiming control over 108."* The app always offers **Call 108 directly**.

**"Who can change what citizens see?"**
Only logged-in hospital staff: **Hospital ID + Staff ID + OTP**. Sessions are bound to one hospital, and permissions depend on role. Every login, change, referral decision and denied attempt goes into the **audit log**.

| Role | Can do |
|---|---|
| Hospital Nodal Officer | Everything for their hospital + audit log |
| Emergency Desk Officer | Accept/decline referrals, ER open/busy/diverting, confirm figures |
| Resource Manager | Beds, specialists on duty, equipment, confirm figures |
| State Health Admin | Read-only view of all hospitals + audit logs |

**"Isn't giving first aid medical advice risky?"**
It's secondary and framed as *"Safety steps while help is arranged – standard first-aid guidance, not medical advice"*, collapsed by default. The exception is CPR, which opens when someone is "not breathing". The product is **emergency coordination**, and every AI screen says *"This is not a diagnosis. Doctors decide treatment."*

**"What about someone living alone?"**
**🆘 I'm alone mode:** one tap does all five steps automatically, with a live checklist:
1. Location shared
2. Trusted contact notified with a tracking link
3. Hospital request sent
4. Hospital accepted
5. Ambulance requested

The trusted contact's link shows status, hospital and ETA, with **no medical details**.

**"Privacy?"** See [docs/PRIVACY-SECURITY.md](docs/PRIVACY-SECURITY.md). In short:
- minimum data, with explicit consent before patient details are shared
- health cards are read on the phone
- ID numbers are masked
- only the referred hospital can access the case
- family view has no medical data
- audit trail on every action
- automatic deletion 24 h after hand-over

---

## The flow (our flowchart, implemented step by step)

```
PERSON / FAMILY                                           (or 🆘 I'M ALONE → all steps automatic)
      │
🚨 SUDDEN EMERGENCY ─────────── speak (Hindi/English/Hinglish) · type · quick-pick · 📷 photo · 🪪 scan health card
      │
🧠 AI UNDERSTANDS ──────────── extracts type, severity, red flags, age group, REQUIRED CAPABILITIES
      │                          ("may indicate…", not a diagnosis) · one follow-up question at a time
📍 GET USER LOCATION ────────── GPS starts at app launch, tap map to correct
      │
🏥 FIND SUITABLE HOSPITALS      ← deterministic engine, no AI
   ┌──┴───────────────┐
Capability available?  Current status?
(service exists AND    (ER open/busy/diverting, beds REPORTED,
 specialist on duty AND  🟢🟡🔴 freshness, predicted bed on arrival,
 machine working)        ER wait, data source)
   └──┬───────────────┘
⏱️ DISTANCE + ETA ───────────── traffic-aware ETA for this hour of day
      │
📋 SHOW OPTIONS ─────────────── "Why this hospital?" checklist + explained score + "why others were excluded"
      │                          + golden-hour "stabilise first" option · 🔒 consent before sharing details
🏥 HOSPITAL CONFIRMS ────────── authorised staff accept + assign receiving bay (AI SBAR pre-arrival note)
      │                          declined / no answer → next hospital automatically
🚑 TRANSPORT ────────────────── ambulance request (simulated → 108 control room in deployment) or own vehicle
      │
🗺️ NAVIGATION ───────────────── route, turn-by-turn, voice, live tracking, family tracking link
      │
🏥 CONFIRMED HOSPITAL ───────── reported capacity ≠ referral accepted ≠ confirmed destination
```

**Home page**
![](docs/screenshots/0-home.png)

**Citizen dashboard**
![](docs/screenshots/1-citizen-dashboard.png)

**Hospital dashboard**
![](docs/screenshots/2-hospital-dashboard.png)

| Sign in (role cards) | Referral review (staff) | Emergency flow: referral accepted | I'm alone |
|---|---|---|---|
| ![](docs/screenshots/3-login.png) | ![](docs/screenshots/4-referral-review.png) | ![](docs/screenshots/5-referral-accepted.png) | ![](docs/screenshots/6-im-alone.png) |

## Every suggested technology, where it is used

| Technology | How Sehat Setu uses it | Code |
|---|---|---|
| **Generative AI** | Claude extracts requirements from messy multilingual descriptions and drafts an **SBAR pre-arrival handover note** for the ER doctor. | `server/llm.js` |
| **Voice Bots** | Speak the emergency in Hindi or English. Acceptance, safety steps and directions are read aloud, and the console announces new referrals. | `public/js/voice.js` |
| **Computer Vision** | Photo of the wound or scene → Claude vision describes visible findings. Offline: on-device pixel check for blood or burns. The photo is never uploaded when offline. | `server/llm.js`, `public/js/vision.js` |
| **OCR** | Scan an Ayushman / ABHA card or prescription **on the phone** (Tesseract.js). Details are shared only with consent, and IDs are masked for hospitals. | `public/js/ocr.js`, `shared/ocr-parse.js` |
| **Predictive Analytics** | Traffic-aware ETA, Poisson **bed-on-arrival** probability (weighted by freshness), ER wait, 8-hour arrival forecast for staffing. | `shared/predict.js` |
| **Conversational AI** | One follow-up question at a time; severity and guidance update after each answer. | `shared/triage.js` |
| **Mobile Applications** | Installable PWA, Hindi/English, offline mode (triage and matching run on the phone). | `public/`, `public/sw.js` |

## Architecture

```
Citizen PWA ─┐                         ┌─ server/api.js   one set of routes & rules (also used by the demo file)
Family link ─┼── REST + SSE (HTTPS) ───┤  server/auth.js  Hospital ID + Staff ID + OTP, sessions, RBAC
Hospital     │                         │  server/store.js cases, audit log, freshness stamps, consent,
console ─────┘                         │                  masked views, retention purge, simulations
                                       └─ server/llm.js   Claude (optional)
shared/ (runs on server AND phone): triage · matching · predict · freshness · roles · capabilities · ocr-parse · handover
```

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/triage` · `/api/vision` | citizen | AI understanding → requirements |
| `POST /api/match` | citizen | Deterministic ranking + checklist + score breakdown |
| `POST /api/cases` | citizen | Create case → returns case token + family track token (once) |
| `POST /api/cases/:id/request` · `/transport` · `/arrived` | citizen (`X-Case-Token`) | Referral, transport, arrival |
| `GET /api/track/:id?t=` | trusted contact | Status only, no medical data |
| `POST /api/auth/otp` · `/api/auth/verify` · `/api/auth/logout` | staff | Login |
| `POST /api/hospitals/:id/cases/:caseId/respond` | staff (`referral.respond`) | Accept/decline + receiving bay |
| `PATCH /api/hospitals/:id/status` | staff (role-dependent) | Update or confirm figures → re-verifies |
| `GET /api/hospitals/:id/audit` | Nodal Officer / Admin | Audit log |
| `GET /api/stream/...` | per token | Live updates (SSE) |

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SEHAT_DATA_MODE` | `demo` | `live` = never return OTP, no demo staff list |
| `ANTHROPIC_API_KEY` | – | Enables Claude |
| `SEHAT_RETENTION_MS` | 24 h | Delete personal/health details this long after hand-over |
| `SEHAT_RESPONSE_TIMEOUT_MS` | `60000` | Auto-escalate if logged-in staff don't respond |
| `SEHAT_SIM_RESPONSE_MS` | `3500` | Simulated desk delay (only when no staff logged in) |
| `SEHAT_DEMO_SPEED` | `15` | Ambulance simulation speed |

## 3-minute demo script

0. Open the **home page** (`/`). Show the live network stats, the 7-step flow and the two separate portals. Then **Citizen login → Create account** on the phone.
1. **Hospital dashboard:** `/login` → **Hospital Staff** → *Bansal Hospital → BANSAL-ED01 → OTP* (shown on screen in demo). Point at the KPI tiles, *"Updated by / Time / Data source"* and the **DEMO** banner.
2. **Phone:** say *"Papa ko seene mein dard hai, pasina aa raha hai, 62 saal"*. The app shows *"may indicate: Heart attack · CRITICAL · needs cardiologist + ICU"*. Open **How was this decided?**: AI → requirements → deterministic engine.
3. **Find hospitals.** Walk through one **Why this hospital?** checklist, the 🟢/🟡/🔴 freshness badges (Siddhanta 🟡, People's 🔴 excluded anyway: cardiologist off duty), and tap **Match score → what does it mean?**
4. **Console:** set ER to **Diverting**. The phone shows a live update and Bansal disappears. Set it back to **Open**: Bansal returns as *"Verified just now"*.
5. **Ask hospital to accept.** The console beeps and shows the SBAR note, with IDs masked and no details without consent. Enter bay *Resus-02* and **Accept referral**. The phone shows **Reported capacity → ACCEPTED by Emergency Desk Officer (name) → Confirmed destination, bay Resus-02**.
6. **Request ambulance.** Note the *simulated* label and "Call 108 directly". Open **Preview what your contact sees**: status only, no medical details.
7. Log in as **BANSAL-NO01** (Nodal Officer) to show the **audit log**. On the phone, open the **citizen dashboard → My Cases**: the case shows *Accepted*, and the recent activity is updated.
8. New tab → save a trusted contact → **🆘 I'm alone**. All five steps complete by themselves.

## Limitations & roadmap
- Integrate the NHA Health Facility Registry, hospital HMIS feeds and the 108 CAD system (live mode).
- ABHA consent-based record fetch (ABDM) instead of OCR-only.
- IVR / missed-call channel for feature phones; SMS gateway for OTP and trusted-contact alerts.
- Persistent encrypted database, key management and a formal DPDP Act 2023 impact assessment.
- Clinical validation of the triage rules with emergency physicians.

> ⚠️ Sehat Setu is a prototype and does not replace medical advice. In an emergency, always call **108**.
