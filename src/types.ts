/** Shared constants (email validation code is reused from Fairquery Email Validator: checks.ts, dns.ts, data/disposable.ts). */
export const SCHEMA_VERSION = '1.0.0';
export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
export type Verdict = 'valid' | 'risky' | 'invalid' | 'unknown';
