// Medreach – field encryption for personal and health data (AES-256-GCM).
//
// Patient details, the raw emergency description and the trusted contact are
// stored only in sealed form. Each value gets a fresh 12-byte IV and an auth
// tag, so tampered data is rejected instead of silently decrypted.
//
// Key: SEHAT_DATA_KEY (32 bytes, base64 or hex). Without it a random key is
// generated at start-up, which is safe for the in-memory demo (data dies with
// the process anyway) but must be set for any persistent deployment.

import crypto from 'node:crypto';

function parseKey(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('SEHAT_DATA_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  return buf;
}

export function createVault(rawKey = process.env.SEHAT_DATA_KEY) {
  const configured = parseKey(rawKey);
  const key = configured || crypto.randomBytes(32);
  return {
    persistentKey: Boolean(configured),
    seal(value) {
      if (value === undefined) return undefined;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
    },
    open(sealed) {
      if (sealed === undefined) return undefined;
      const [v, iv, tag, data] = String(sealed).split('.');
      if (v !== 'v1') throw new Error('unknown vault format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
    },
  };
}
