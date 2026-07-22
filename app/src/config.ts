// Central place for reading environment/config. Nothing else in the app
// should read process.env directly, so configuration stays understandable
// and swappable.

import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '..');

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export const config = {
  rootDir: ROOT_DIR,
  port: parseInt(process.env.PORT ?? '', 10) || 3000,

  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',

  // Absolute path to the SQLite file. Resolved against the project root so a
  // relative DATABASE_PATH works regardless of the current working directory.
  databasePath: path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/sheetsmart.sqlite'),

  // Base64-encoded service-account JSON. Empty is allowed: the app runs and
  // reports "Not connected" until the owner supplies it.
  googleServiceAccountJsonB64: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || '',

  isProduction: (process.env.NODE_ENV || '').toLowerCase() === 'production',
  // Allow disabling the login gate ONLY for local development convenience.
  disableAuth: bool(process.env.DISABLE_AUTH, false),
};

// Warn loudly (but do not crash) when critical secrets are missing, so the
// owner gets a clear message instead of a silent misconfiguration.
export function warnings(): string[] {
  const out: string[] = [];
  if (!config.adminPassword) {
    out.push('ADMIN_PASSWORD is not set — the login gate is effectively open. Set it in .env before deploying.');
  }
  if (config.sessionSecret === 'insecure-dev-secret-change-me') {
    out.push('SESSION_SECRET is using the insecure default — set a long random value in .env before deploying.');
  }
  if (!config.googleServiceAccountJsonB64) {
    out.push('GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not set — Google connection tests will report "Not connected".');
  }
  return out;
}
