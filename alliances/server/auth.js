'use strict';
const crypto = require('node:crypto');

// 7-digit codes are hashed with scrypt (built in, no native dependency).
function hashCode(code) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(code), salt, 32).toString('hex');
}
function verifyCode(code, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(String(code), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const validCode = (c) => /^\d{7}$/.test(String(c));

// Stateless signed session tokens.
const b64 = (b) => Buffer.from(b).toString('base64url');
function signToken(secret, payload, ttlMs = 14 * 864e5) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function readToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== good.length || !crypto.timingSafeEqual(good, given)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

// Sliding-window limiter: a 7-digit code only has 10 million combinations.
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list); return true;
  };
}
module.exports = { hashCode, verifyCode, validCode, signToken, readToken, makeLimiter };
