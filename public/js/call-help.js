// "Call 108 / 112 / 102" links use tel:, which opens the dialer on a phone but
// does nothing useful on a laptop or desktop (Windows asks "pick an app" or
// silently ignores it). On devices that can't place calls we show a short
// panel instead: the number in large type, what to do, and a way to ask for
// help through Medreach. Phones keep the normal one-tap call.

const NAMES = {
  108: ['Ambulance (free, 24×7)', 'एम्बुलेंस – मुफ़्त, 24 घंटे'],
  102: ['Janani Express – pregnancy & newborn', 'जननी एक्सप्रेस – गर्भवती और नवजात'],
  112: ['National emergency number', 'राष्ट्रीय आपातकालीन नंबर'],
};

export function canPlaceCalls(nav = globalThis.navigator) {
  if (!nav) return false;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean' && nav.userAgentData.mobile) return true;
  return /Android|iPhone|iPod|Windows Phone|Mobile/i.test(nav.userAgent || '');
}

const CSS = `
.callhelp{position:fixed;inset:0;z-index:5000;display:grid;place-items:center;padding:16px;background:rgba(15,23,42,.55)}
.callhelp-box{width:min(420px,100%);background:#fff;color:#0f172a;border-radius:16px;padding:22px 20px 18px;box-shadow:0 20px 50px rgba(0,0,0,.3);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
.callhelp-num{font-size:56px;font-weight:800;letter-spacing:2px;color:#be123c;line-height:1;margin:6px 0 4px}
.callhelp-box h2{margin:0;font-size:17px}
.callhelp-box p{margin:10px 0;color:#334155}
.callhelp-box small{color:#64748b}
.callhelp-actions{display:grid;gap:8px;margin-top:14px}
.callhelp-actions a,.callhelp-actions button{display:block;padding:11px 14px;border-radius:10px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;font:600 15px system-ui,sans-serif;text-decoration:none;cursor:pointer}
.callhelp-actions .go{background:#be123c;border-color:#be123c;color:#fff}
.callhelp-actions .quiet{border:0;color:#475569;font-weight:500}
`;

let open = null;

function close() {
  if (!open) return;
  open.remove();
  open = null;
  document.removeEventListener('keydown', onKey);
}
function onKey(e) { if (e.key === 'Escape') close(); }

export function showCallHelp(num) {
  close();
  num = String(num).replace(/[^\d+]/g, '');
  if (!document.getElementById('callhelp-css')) {
    const st = document.createElement('style');
    st.id = 'callhelp-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const [en, hi] = NAMES[num] || ['Emergency number', 'आपातकालीन नंबर'];
  const onReport = location.pathname.startsWith('/report');
  const wrap = document.createElement('div');
  wrap.className = 'callhelp';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'callhelp-title');
  wrap.innerHTML = `
    <div class="callhelp-box">
      <h2 id="callhelp-title">Dial this number from any phone</h2>
      <div class="callhelp-num">${num}</div>
      <b>${en}</b><br><small>${hi}</small>
      <p>This computer can't place phone calls. Dial <b>${num}</b> on a mobile or landline – it is free and works even without balance.<br><small>कंप्यूटर से कॉल नहीं हो सकती – किसी भी फ़ोन से <b>${num}</b> डायल करें।</small></p>
      <div class="callhelp-actions">
        ${onReport ? '' : '<a class="go" href="/report">Request an ambulance through Medreach</a>'}
        <a href="tel:${num}" data-callhelp-direct>Call from this computer (Phone Link / Skype)</a>
        <button type="button" class="quiet" data-callhelp-close>Close</button>
      </div>
    </div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-callhelp-close]')) close();
    else if (e.target.closest('[data-callhelp-direct]')) setTimeout(close, 0);
  });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  open = wrap;
  wrap.querySelector('.callhelp-actions a, .callhelp-actions button').focus();
}

/** One delegated listener covers every tel: link, including ones rendered later. */
export function installCallHelp({ doc = globalThis.document, nav = globalThis.navigator } = {}) {
  if (!doc || canPlaceCalls(nav)) return false;
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href^="tel:"]');
    if (!a || a.hasAttribute('data-callhelp-direct')) return;
    e.preventDefault();
    showCallHelp(a.getAttribute('href').slice(4));
  });
  return true;
}

installCallHelp();
