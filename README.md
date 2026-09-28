# Sehat Setu (सेहत सेतु)
**"A bridge to health": Har gaon tak samay par ilaaj (timely care for every village)**

A voice-first AI co-pilot for ASHA workers, plus a live dashboard for district health officers (Shahdol, MP).
Built for MP Idea & Innovation Hackathon, Challenge 5 (AI for Public Services, Healthcare).

> The AI only **flags risk and refers**. It never diagnoses. This is a prototype with mock data.

## Run
Double-click `index.html` (you need internet the first time, because React, Tailwind, Leaflet and Chart.js load from a CDN). There's no build step, no backend and no API keys.

## Demo flow
1. Open **Demo Mode**. The ASHA phone is on the left and the district dashboard on the right, and both use the same live state.
2. ASHA app → **Voice Check-up** → tap sample 1: *"7 mahine ki garbhvati, sir dard aur pair mein sujan"*.
3. The AI asks for BP. Type **150/100** and the result is **RED: possible pre-eclampsia risk**.
4. Tap **Refer now** to generate the slip, then tap **Alert PHC** (and **Call 108**).
5. A new pulsing red marker and a live alert appear on the dashboard at once, and the KPIs update.

## Features
- ASHA app: voice check-up (Web Speech API, hi-IN, with typed fallback), register OCR (mock), anaemia photo screening (canvas redness R/(R+G+B)), high-risk pregnancy score (0-100 with factor breakdown), referral slip + PHC alert + 108 timeline, and a patient list.
- Dashboard: KPIs, Leaflet risk map (falls back to an SVG map), Chart.js charts, a live alerts feed, a predictive hotspot card, a referral table and an ASHA leaderboard.
- Full Hindi/English toggle and an About modal.
