// Builds demo/sehat-setu-prototype.html – ONE self-contained file that runs the
// whole prototype by double-clicking it (no Node.js, no server):
//   • left:  the real citizen app (public/js/app.js) inside a phone frame
//   • right: the real hospital console (public/js/hospital.js)
//   • both talk to an in-browser backend (demo/demo-server.js)
//
// Usage: npm run build:demo

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Resolve the browser's absolute "/shared/x.js" imports to files on disk.
const sharedPaths = {
  name: 'shared-paths',
  setup(b) {
    b.onResolve({ filter: /^\/shared\// }, (args) => ({ path: path.join(root, args.path) }));
  },
};

async function bundle(entry) {
  const out = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
    plugins: [sharedPaths],
    legalComments: 'none',
  });
  return out.outputFiles[0].text;
}

const [appJs, hospitalJs, serverJs] = await Promise.all([
  bundle('public/js/app.js'),
  bundle('public/js/hospital.js'),
  bundle('demo/demo-server.js'),
]);
const shimJs = read('demo/client-shim.js');
const css = read('public/css/app.css');
const leafletCss = read('node_modules/leaflet/dist/leaflet.css');
const leafletJs = read('node_modules/leaflet/dist/leaflet.js');
const iconSvg = read('public/icons/icon.svg');
const iconUri = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;

const uiCss = read('public/css/ui.css');

// Page body (with its <body> attributes); links to other pages are neutralised
// because each frame is a single embedded document.
const bodyOf = (file) => {
  const m = /<body([^>]*)>([\s\S]*)<\/body>/.exec(read(file));
  return {
    attrs: m[1],
    html: m[2]
      .replace(/<script\b[\s\S]*?<\/script>/g, '')
      .replaceAll('/icons/icon.svg', iconUri)
      .replace(/href="\/[^"]*"/g, 'href="#"'),
  };
};

const page = (title, body, scripts, styles) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans:wght@400;600;700;800&family=Noto+Sans+Devanagari:wght@400;600;700&display=swap">
${styles.map((st) => `<style>${st}</style>`).join('')}</head>
<body${body.attrs}>${body.html}${scripts.map((sc) => `<script>${sc}</script>`).join('')}</body></html>`;

const templates = {
  citizen: page('Sehat Setu – Emergency', bodyOf('public/report.html'), [leafletJs, shimJs, appJs], [leafletCss, css]),
  hospital: page('Sehat Setu – Hospital Dashboard', bodyOf('public/hospital.html'), [leafletJs, shimJs, hospitalJs], [leafletCss, uiCss]),
};
// Safe to embed inside <script>: no "</" or "<!--" sequences.
const templatesJs = `window.__TPL=${JSON.stringify(templates).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--')};`;

const shell = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sehat Setu Prototype</title>
<meta name="description" content="Sehat Setu – AI emergency healthcare bridge. Interactive prototype: citizen app and hospital console.">
<link rel="icon" href="${iconUri}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;700;800&display=swap">
<style>
:root { --bg:#e9eef5; --surface:#fff; --ink:#0f1b2d; --muted:#5d6a80; --line:#d6dde8; --brand:#0b7a75; --brand-ink:#fff; --sos:#d62839; --phone:#0f1b2d; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#070c14; --surface:#111a28; --ink:#e8edf6; --muted:#8e9ab0; --line:#243149; --brand:#2bb3a9; --brand-ink:#04211f; --sos:#ff4d5e; --phone:#000; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#070c14; --surface:#111a28; --ink:#e8edf6; --muted:#8e9ab0; --line:#243149; --brand:#2bb3a9; --brand-ink:#04211f; --sos:#ff4d5e; --phone:#000; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 15px/1.45 "Noto Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: .75rem; padding: .6rem 1rem; background: var(--surface); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header img { width: 30px; height: 30px; }
header h1 { font-size: 1rem; margin: 0; }
header p { margin: 0; font-size: .8rem; color: var(--muted); }
.spacer { flex: 1; }
.toggle { display: inline-flex; align-items: center; gap: .45rem; font-size: .85rem; cursor: pointer; user-select: none; }
.toggle input { width: 18px; height: 18px; accent-color: var(--brand); }
.tabs { display: none; gap: .4rem; padding: .5rem 1rem 0; }
.tabs button { flex: 1; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 10px; padding: .55rem; font: inherit; font-weight: 600; cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--brand); color: var(--brand-ink); border-color: var(--brand); }
.stage { flex: 1; display: grid; grid-template-columns: 420px 1fr; gap: 1rem; padding: 1rem; min-height: 0; }
.pane { display: flex; flex-direction: column; min-height: 0; }
.pane h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 .5rem; }
.phone { flex: 1; border: 10px solid var(--phone); border-radius: 36px; overflow: hidden; background: #fff; box-shadow: 0 20px 50px rgba(15,27,45,.25); max-height: 880px; min-height: 0; }
.desk { flex: 1; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--surface); min-height: 0; }
iframe { width: 100%; height: 100%; border: 0; display: block; }
.toast { position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-50%) translateY(150%); background: var(--ink); color: var(--bg); padding: .75rem 1rem; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); display: flex; gap: .75rem; align-items: center; transition: transform .25s; max-width: calc(100% - 2rem); z-index: 10; }
.toast.show { transform: translateX(-50%) translateY(0); }
.toast button { border: 0; background: var(--sos); color: #fff; border-radius: 8px; padding: .4rem .7rem; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap; }
@media (min-width: 901px) { .toast button { display: none; } }
@media (max-width: 900px) {
  .tabs { display: flex; }
  .stage { grid-template-columns: 1fr; padding: .5rem 0 0; }
  .pane h2 { display: none; }
  .pane.hidden-mobile { display: none; }
  .phone { border: 0; border-radius: 0; box-shadow: none; max-height: none; }
  .desk { border: 0; border-radius: 0; }
}
</style>
</head>
<body>
<header>
  <img src="${iconUri}" alt="">
  <div><h1>Sehat Setu – interactive prototype</h1><p>Emergency → Understand → Match → Verify → Accept → Transport → Confirm. <b>Demo mode:</b> hospital data, SMS and ambulance dispatch are simulated.</p></div>
  <span class="spacer"></span>
  <label class="toggle" title="When on, admission requests go to the hospital console and wait for YOU to accept. When off, the ER desk is simulated.">
    <input type="checkbox" id="staffed"> I'll act as the hospital desk
  </label>
</header>
<nav class="tabs" role="tablist">
  <button role="tab" id="tabCitizen" aria-selected="true">📱 Citizen app</button>
  <button role="tab" id="tabDesk" aria-selected="false">🏥 Hospital console</button>
</nav>
<main class="stage">
  <section class="pane" id="paneCitizen"><h2>📱 Citizen app (phone)</h2><div class="phone"><iframe id="citizen" title="Citizen app" allow="geolocation *; microphone *; camera *"></iframe></div></section>
  <section class="pane" id="paneDesk"><h2>🏥 Hospital emergency console</h2><div class="desk"><iframe id="desk" title="Hospital console" allow="microphone *"></iframe></div></section>
</main>
<div class="toast" id="toast" role="status"><span id="toastText"></span><button id="toastBtn" type="button">Open console</button></div>
<script>${serverJs}</script>
<script>${templatesJs}</script>
<script>
(function () {
  var citizen = document.getElementById('citizen');
  var desk = document.getElementById('desk');
  var staffed = document.getElementById('staffed');
  var narrow = window.matchMedia('(max-width: 900px)');
  staffed.checked = !narrow.matches; // on big screens, you play the hospital desk
  citizen.srcdoc = window.__TPL.citizen;
  desk.srcdoc = window.__TPL.hospital;

  function show(which) {
    document.getElementById('paneCitizen').classList.toggle('hidden-mobile', which !== 'citizen');
    document.getElementById('paneDesk').classList.toggle('hidden-mobile', which !== 'desk');
    document.getElementById('tabCitizen').setAttribute('aria-selected', String(which === 'citizen'));
    document.getElementById('tabDesk').setAttribute('aria-selected', String(which === 'desk'));
  }
  document.getElementById('tabCitizen').onclick = function () { show('citizen'); };
  document.getElementById('tabDesk').onclick = function () { show('desk'); };
  show('citizen');

  var toastTimer;
  function toast(text) {
    document.getElementById('toastText').textContent = text;
    var t = document.getElementById('toast');
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 9000);
  }
  document.getElementById('toastBtn').onclick = function () { show('desk'); document.getElementById('toast').classList.remove('show'); };

  var server = window.sehatServer;
  // "Staffed" mode: log the console in as the requested hospital's Emergency
  // Desk Officer (real OTP flow, demo OTP), so the referral waits for YOU.
  server.hooks.beforeRequest = async function (hospitalId) {
    if (!staffed.checked) return;
    var consoleApi = desk.contentWindow && desk.contentWindow.sehatConsole;
    if (!consoleApi) return;
    try { await consoleApi.demoLogin(hospitalId, 'ED01'); } catch (e) { return; }
    for (var i = 0; i < 40 && server.store.listeners('hospital:' + hospitalId) === 0; i++) {
      await new Promise(function (r) { setTimeout(r, 50); });
    }
  };
  server.hooks.afterRequest = function (hospitalId, waitingForHuman) {
    // On wide screens the console is visible and shows its own alert.
    if (!waitingForHuman || !narrow.matches) return;
    var h = server.store.getHospital(hospitalId);
    toast('🔔 ' + h.name + ' received the referral – you are logged in as its Emergency Desk Officer: accept it in the console');
  };
})();
</script>
</body>
</html>
`;

const outFile = path.join(root, 'demo', 'sehat-setu-prototype.html');
fs.writeFileSync(outFile, shell);
console.log(`✓ ${path.relative(root, outFile)} (${Math.round(shell.length / 1024)} KB)`);
