import { DISPOSABLE_DOMAINS } from './data/disposable.js';
import type { Verdict } from './types.js';

export const ROLE_LOCAL_PARTS = new Set([
    'abuse',
    'accounts',
    'admin',
    'administrator',
    'billing',
    'careers',
    'contact',
    'enquiries',
    'feedback',
    'finance',
    'hello',
    'help',
    'hostmaster',
    'hr',
    'info',
    'inquiries',
    'jobs',
    'legal',
    'mail',
    'marketing',
    'media',
    'newsletter',
    'no-reply',
    'noreply',
    'office',
    'orders',
    'postmaster',
    'press',
    'privacy',
    'root',
    'sales',
    'security',
    'service',
    'shop',
    'support',
    'team',
    'webmaster',
]);

export const FREE_PROVIDERS = new Set([
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'yahoo.co.uk',
    'yahoo.fr',
    'ymail.com',
    'hotmail.com',
    'hotmail.co.uk',
    'hotmail.fr',
    'outlook.com',
    'live.com',
    'msn.com',
    'aol.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'proton.me',
    'protonmail.com',
    'pm.me',
    'gmx.com',
    'gmx.de',
    'gmx.net',
    'web.de',
    'mail.com',
    'mail.ru',
    'yandex.ru',
    'yandex.com',
    'zoho.com',
    'qq.com',
    '163.com',
    '126.com',
    'naver.com',
    'free.fr',
    'orange.fr',
    'laposte.net',
    'libero.it',
    't-online.de',
    'seznam.cz',
    'wp.pl',
    'o2.pl',
    'interia.pl',
    'rediffmail.com',
    'tutanota.com',
    'tuta.io',
    'fastmail.com',
    'hey.com',
    'btinternet.com',
    'comcast.net',
    'att.net',
    'sbcglobal.net',
    'verizon.net',
    'bigpond.com',
    'shaw.ca',
    'rogers.com',
    'uol.com.br',
    'bol.com.br',
]);

/** Common domains used for typo suggestions. */
const TYPO_TARGETS = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'icloud.com',
    'aol.com',
    'live.com',
    'proton.me',
    'protonmail.com',
    'gmx.com',
    'gmx.de',
    'web.de',
    'yandex.ru',
    'mail.ru',
    'msn.com',
    'googlemail.com',
];
const TLD_TYPOS: Record<string, string> = {
    con: 'com',
    cmo: 'com',
    ocm: 'com',
    vom: 'com',
    comm: 'com',
    om: 'com',
    nett: 'net',
    ogr: 'org',
};

export function levenshtein(a: string, b: string): number {
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = dp[j];
            dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return dp[b.length];
}

export interface ParsedEmail {
    email: string;
    local: string;
    domain: string;
}

/**
 * Pragmatic syntax check (RFC 5321/5322 subset used by real mailbox providers):
 * dot-atom local part, LDH domain labels, TLD of letters (or xn--), length limits.
 */
export function parseEmail(raw: string): ParsedEmail | null {
    let s = raw.trim();
    const angle = /<([^<>]+)>\s*$/.exec(s);
    if (angle) s = angle[1].trim();
    s = s.replace(/^mailto:/i, '');
    const at = s.lastIndexOf('@');
    if (at <= 0 || at === s.length - 1) return null;
    const local = s.slice(0, at);
    let domain = s
        .slice(at + 1)
        .toLowerCase()
        .replace(/\.$/, '');
    if (local.length > 64 || s.length > 254) return null;
    if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return null;
    try {
        if ([...domain].some((c) => c.charCodeAt(0) > 127)) domain = new URL(`http://${domain}`).hostname;
    } catch {
        return null;
    }
    const labels = domain.split('.');
    if (labels.length < 2) return null;
    for (const l of labels) {
        if (!l || l.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) return null;
    }
    const tld = labels[labels.length - 1];
    if (!/^([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) return null;
    return { email: `${local}@${domain}`, local, domain };
}

export function isDisposable(domain: string): boolean {
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        if (DISPOSABLE_DOMAINS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}

export function isRole(local: string): boolean {
    const base = local.toLowerCase().split('+')[0];
    return ROLE_LOCAL_PARTS.has(base);
}

export function isFreeProvider(domain: string): boolean {
    return FREE_PROVIDERS.has(domain);
}

export function suggestDomain(domain: string): string | null {
    if (FREE_PROVIDERS.has(domain)) return null;
    const parts = domain.split('.');
    const tld = parts[parts.length - 1];
    if (TLD_TYPOS[tld]) {
        const fixed = [...parts.slice(0, -1), TLD_TYPOS[tld]].join('.');
        return fixed;
    }
    let best: string | null = null;
    let bestD = 3;
    for (const t of TYPO_TARGETS) {
        const d = levenshtein(domain, t);
        if (d > 0 && d < bestD) {
            best = t;
            bestD = d;
        }
    }
    return bestD <= 2 ? best : null;
}

const PROVIDER_PATTERNS: [RegExp, string][] = [
    [/google\.com\.?$|googlemail\.com\.?$/, 'Google Workspace / Gmail'],
    [/outlook\.com\.?$|hotmail\.com\.?$|protection\.outlook/, 'Microsoft 365 / Outlook'],
    [/yahoodns\.net\.?$/, 'Yahoo'],
    [/icloud\.com\.?$/, 'Apple iCloud'],
    [/protonmail\.ch\.?$/, 'Proton Mail'],
    [/zoho\.(com|eu|in)\.?$/, 'Zoho Mail'],
    [/mimecast\.com\.?$/, 'Mimecast'],
    [/pphosted\.com\.?$/, 'Proofpoint'],
    [/messagingengine\.com\.?$/, 'Fastmail'],
    [/secureserver\.net\.?$/, 'GoDaddy'],
    [/yandex\.(net|ru)\.?$/, 'Yandex'],
    [/mail\.ru\.?$/, 'Mail.ru'],
    [/amazonaws\.com\.?$|awsapps\.com\.?$/, 'Amazon SES / WorkMail'],
    [/barracudanetworks\.com\.?$/, 'Barracuda'],
];

export function mailProviderOf(exchanges: string[]): string | null {
    for (const ex of exchanges) {
        for (const [re, name] of PROVIDER_PATTERNS) if (re.test(ex.toLowerCase())) return name;
    }
    return null;
}

export interface VerdictInput {
    syntaxValid: boolean;
    disposable: boolean;
    role: boolean;
    free: boolean;
    domainExists: boolean | null;
    hasMx: boolean | null;
    nullMx: boolean;
    implicitMx: boolean;
    didYouMean: string | null;
    allowRole: boolean;
    allowDisposable: boolean;
    allowFree: boolean;
}

export function verdictOf(v: VerdictInput): { verdict: Verdict; reasons: string[] } {
    const reasons: string[] = [];
    if (!v.syntaxValid) return { verdict: 'invalid', reasons: ['INVALID_SYNTAX'] };
    if (v.domainExists === false) reasons.push('DOMAIN_NOT_FOUND');
    if (v.nullMx) reasons.push('NULL_MX');
    if (v.domainExists && v.hasMx === false && !v.implicitMx && !v.nullMx) reasons.push('NO_MAIL_SERVER');
    if (reasons.length) return { verdict: 'invalid', reasons };
    if (v.disposable) reasons.push('DISPOSABLE_DOMAIN');
    if (v.role) reasons.push('ROLE_ACCOUNT');
    if (v.free) reasons.push('FREE_PROVIDER');
    if (v.didYouMean) reasons.push('POSSIBLE_TYPO');
    if (v.implicitMx) reasons.push('IMPLICIT_MX_ONLY');
    if (v.hasMx === null) reasons.push('DNS_NOT_CHECKED');
    const risky =
        (v.disposable && !v.allowDisposable) ||
        (v.role && !v.allowRole) ||
        (v.free && !v.allowFree) ||
        Boolean(v.didYouMean) ||
        v.implicitMx;
    if (risky) return { verdict: 'risky', reasons };
    if (v.hasMx === null) return { verdict: 'unknown', reasons };
    return { verdict: 'valid', reasons };
}
