// Single-admin auth (handoff Section 3). A correct password sets a signed
// session cookie; every protected route checks it. Kept behind this module so
// it can later be swapped for Google OAuth restricted to one email.

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

export const COOKIE_NAME = 'ss_session';
// Cookie lifetime: 12 hours. A one-person internal tool does not need more.
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Constant-time comparison to avoid leaking password length/first-diff timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still spend time comparing to blunt timing analysis.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function sign(value: string): string {
  const h = crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  return `${value}.${h}`;
}

function verifySigned(signed: unknown): string | null {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  if (!safeEqual(signed, expected)) return null;
  return value;
}

export function issueSession(res: Response): void {
  // The cookie payload is just an issue-timestamp; validity is proven by the
  // HMAC signature (only our server can produce it) plus the expiry check.
  const payload = String(Date.now());
  const signed = sign(payload);
  res.cookie(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function isAuthenticated(req: Request): boolean {
  if (config.disableAuth) return true;
  const raw = req.cookies ? req.cookies[COOKIE_NAME] : null;
  const payload = verifySigned(raw);
  if (!payload) return false;
  const issuedAt = parseInt(payload, 10);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < SESSION_MAX_AGE_MS;
}

export function checkPassword(password: unknown): boolean {
  // If no admin password is configured, refuse to authenticate rather than
  // silently allowing everyone in. (config.ts already warns loudly at boot.)
  if (!config.adminPassword) return false;
  return safeEqual(typeof password === 'string' ? password : '', config.adminPassword);
}

// Express middleware guarding API routes. Returns 401 JSON so the frontend can
// redirect to the login screen.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
