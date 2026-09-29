// In-browser version of the Sehat Setu backend, used only by the single-file
// demo (demo/sehat-setu-prototype.html). It runs the SAME api.js / store.js /
// auth.js as the Node server (demo data mode, no Claude), so the real citizen
// app and hospital console run unchanged, without Node.js.

import { createStore } from '../server/store.js';
import { createAuth } from '../server/auth.js';
import { createApi } from '../server/api.js';

const store = createStore({ simulatedResponseMs: 2500, responseTimeoutMs: 45000, demoSpeed: 20 });
const auth = createAuth({ demoMode: true, audit: store.audit });
const api = createApi({ store, auth, dataMode: 'demo', ai: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(url, opts = {}) {
  const u = new URL(url, 'http://sehat.demo');
  const headers = new Headers(opts.headers || {});
  const bearer = /^Bearer (.+)$/.exec(headers.get('authorization') || '');
  await sleep(u.pathname === '/api/triage' ? 700 : 120); // feel like a real network
  const { status, data } = await api.handle({
    method: (opts.method || 'GET').toUpperCase(),
    path: u.pathname,
    body: typeof opts.body === 'string' && opts.body ? JSON.parse(opts.body) : {},
    query: Object.fromEntries(u.searchParams),
    token: bearer ? bearer[1] : null,
    caseToken: headers.get('x-case-token'),
  });
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Stand-in for Server-Sent Events.
function stream(url, onEvent, onError) {
  const u = new URL(url, 'http://sehat.demo');
  try {
    const sub = api.stream(u.pathname, Object.fromEntries(u.searchParams), onEvent);
    if (sub.initial) setTimeout(() => onEvent(sub.initial[0], JSON.stringify(sub.initial[1])), 0);
    return sub.unsubscribe;
  } catch (err) {
    onError?.(err);
    return () => {};
  }
}

window.sehatServer = { fetch: apiFetch, stream, store, hooks: api.hooks };
