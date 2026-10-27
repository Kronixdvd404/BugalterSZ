export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg, status = 400) => new HttpError(msg, status);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store'
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers }
  });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const toHex = hex;
export const fromHex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));

export function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}
export const newId = () => randomHex(6);

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
