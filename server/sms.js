// SMS gateway (server side): inbound emergency SMS → POST /api/sms/inbound,
// replies and status updates → outbound sender.
//
// Works with any Indian SMS gateway (MSG91, Gupshup, Kaleyra, Twilio …) through
// a small adapter on their side or ours:
//   inbound   POST /api/sms/inbound  { from, text }
//             authenticated by the same HMAC headers as the 108 webhook
//             (X-Medreach-Timestamp + X-Medreach-Signature), or by
//             X-Medreach-Key: <SEHAT_SMS_SECRET> for gateways that can only add a fixed header
//   outbound  POST SEHAT_SMS_SEND_URL  { to, text }  with Authorization: Bearer SEHAT_SMS_SEND_TOKEN
// Without a send URL, messages are not sent; they are written to the case timeline as "SMS (simulated)".

import { timingSafeEqual } from 'node:crypto';
import { verifySignature } from './ems.js';

export function verifySmsRequest(secret, { key, timestamp, signature, rawBody }) {
  if (!secret) return false;
  if (key) {
    const a = Buffer.from(String(key));
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return verifySignature(secret, { timestamp, signature, rawBody });
}

const cleanPhone = (p) => String(p ?? '').replace(/[^\d+]/g, '').slice(-13);

export function createSmsSender({ url, token, fetchFn = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return {
    live: Boolean(url),
    async send(to, text) {
      const phone = cleanPhone(to);
      if (!url || !phone) return { sent: false, simulated: true };
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ to: phone, text: String(text).slice(0, 640) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`SMS gateway answered HTTP ${res.status}`);
      return { sent: true, simulated: false };
    },
  };
}
