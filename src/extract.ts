import * as cheerio from 'cheerio';
// Package export is "./max"; "./max.js" is not defined in exports.
// eslint-disable-next-line import-x/extensions
import { type CountryCode, findPhoneNumbersInText, parsePhoneNumberFromString } from 'libphonenumber-js/max';

export interface PageData {
    emails: Map<string, string>; // email -> first source url
    phones: Map<string, { raw: string; source_url: string; source: 'tel' | 'json-ld' | 'text' }>;
    socials: Map<string, Set<string>>;
    companyNames: string[];
    descriptions: string[];
    addresses: string[];
    links: { url: string; text: string }[];
}

export function emptyPageData(): PageData {
    return {
        emails: new Map(),
        phones: new Map(),
        socials: new Map(),
        companyNames: [],
        descriptions: [],
        addresses: [],
        links: [],
    };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/g;
const JUNK_EMAIL =
    /\.(?:png|jpe?g|gif|svg|webp|avif|css|js)$|@(?:\d+x\.|example\.|domain\.|email\.com$|yourdomain|sentry|wixpress\.com|sentry-next|.*\.sentry\.io)/i;

export function decodeCfEmail(hex: string): string | null {
    if (!/^[0-9a-f]{4,}$/i.test(hex)) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    // Cloudflare email obfuscation XORs each byte with the key in the first byte.
    // eslint-disable-next-line no-bitwise
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
}

export function deobfuscate(text: string): string {
    return text.replace(/\s*[[({]\s*(?:at|@)\s*[\])}]\s*/gi, '@').replace(/\s*[[({]\s*(?:dot|\.)\s*[\])}]\s*/gi, '.');
}

export function extractEmails(text: string): string[] {
    const out = new Set<string>();
    for (const m of deobfuscate(text).matchAll(EMAIL_RE)) {
        const e = m[0].replace(/^[.]+|[.]+$/g, '').toLowerCase();
        if (!JUNK_EMAIL.test(e)) out.add(e);
    }
    return [...out];
}

const SOCIAL: [string, RegExp, RegExp?][] = [
    ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school|showcase)\/[^/?#]+/i],
    [
        'twitter',
        /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search|hashtag|i\/)[A-Za-z0-9_]{1,15}\/?(?:[?#]|$)/i,
    ],
    ['facebook', /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^?#]+/i],
    ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore|reel)[A-Za-z0-9_.]+/i],
    ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)[^/?#]+/i],
    ['github', /^https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/?(?:[?#]|$)/i],
    ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/?#]+/i],
    ['pinterest', /^https?:\/\/(?:[a-z]{2}\.)?pinterest\.[a-z.]+\/(?!pin\/)[^/?#]+\/?$/i],
    ['crunchbase', /^https?:\/\/(?:www\.)?crunchbase\.com\/organization\/[^/?#]+/i],
    ['threads', /^https?:\/\/(?:www\.)?threads\.net\/@[^/?#]+/i],
    ['bluesky', /^https?:\/\/bsky\.app\/profile\/[^/?#]+/i],
];

export function classifySocial(url: string): { network: string; url: string } | null {
    for (const [network, re] of SOCIAL) {
        const m = re.exec(url);
        if (m)
            return {
                network,
                url: m[0]
                    .replace(/[?#].*$/, '')
                    .replace(/\/$/, '')
                    .replace(/^http:\/\//i, 'https://')
                    .replace(/^https:\/\/www\./i, 'https://'),
            };
    }
    return null;
}

function addPhone(d: PageData, raw: string, source: 'tel' | 'json-ld' | 'text', url: string, country?: string): void {
    const p = parsePhoneNumberFromString(
        raw.replace(/^tel:/i, '').trim(),
        country ? { defaultCountry: country as CountryCode } : undefined,
    );
    if (!p || !p.isPossible()) return;
    const e164 = p.number;
    if (!d.phones.has(e164)) d.phones.set(e164, { raw: raw.replace(/^tel:/i, '').trim(), source_url: url, source });
}

function walkJsonLd(node: unknown, d: PageData, url: string, country?: string): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const n of node) walkJsonLd(n, d, url, country);
        return;
    }
    const o = node as Record<string, unknown>;
    const t = ([] as unknown[]).concat(o['@type'] ?? []).map(String);
    const isOrg = t.some((x) =>
        /Organization|Corporation|LocalBusiness|Store|Restaurant|Company|NGO|Office|Agency|Service|Hotel|Dentist|Attorney|Physician/i.test(
            x,
        ),
    );
    if (isOrg) {
        if (typeof o.name === 'string') d.companyNames.unshift(o.name.trim());
        if (typeof o.legalName === 'string') d.companyNames.unshift(o.legalName.trim());
        if (typeof o.description === 'string') d.descriptions.push(o.description.trim());
        if (typeof o.telephone === 'string') addPhone(d, o.telephone, 'json-ld', url, country);
        if (typeof o.email === 'string')
            for (const e of extractEmails(o.email)) if (!d.emails.has(e)) d.emails.set(e, url);
        for (const s of ([] as unknown[]).concat(o.sameAs ?? [])) {
            const c = typeof s === 'string' ? classifySocial(s) : null;
            if (c) (d.socials.get(c.network) ?? d.socials.set(c.network, new Set()).get(c.network)!).add(c.url);
        }
        const addrs = ([] as unknown[]).concat(o.address ?? []);
        for (const a of addrs) {
            if (typeof a === 'string') d.addresses.push(a.trim());
            else if (a && typeof a === 'object') {
                const p = a as Record<string, unknown>;
                const country2 =
                    typeof p.addressCountry === 'object' && p.addressCountry
                        ? (p.addressCountry as { name?: string }).name
                        : p.addressCountry;
                const parts = [p.streetAddress, p.postalCode, p.addressLocality, p.addressRegion, country2].filter(
                    (x) => typeof x === 'string' && x.trim(),
                );
                if (parts.length) d.addresses.push((parts as string[]).map((s) => s.trim()).join(', '));
            }
        }
    }
    for (const k of ['@graph', 'publisher', 'author', 'provider', 'parentOrganization', 'mainEntity', 'brand'])
        if (o[k]) walkJsonLd(o[k], d, url, country);
}

export function parsePage(html: string, pageUrl: string, d: PageData, opts: { phoneCountry?: string }): void {
    const $ = cheerio.load(html);
    // Cloudflare email protection
    $('[data-cfemail]').each((_, el) => {
        const e = decodeCfEmail($(el).attr('data-cfemail') ?? '');
        if (e) for (const x of extractEmails(e)) if (!d.emails.has(x)) d.emails.set(x, pageUrl);
    });
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            walkJsonLd(JSON.parse($(el).text()), d, pageUrl, opts.phoneCountry);
        } catch {
            /* invalid JSON-LD */
        }
    });
    $('a[href]').each((_, el) => {
        const href = ($(el).attr('href') ?? '').trim();
        if (/^mailto:/i.test(href)) {
            const addr = decodeURIComponent(href.slice(7).split('?')[0]);
            for (const e of extractEmails(addr)) if (!d.emails.has(e)) d.emails.set(e, pageUrl);
            return;
        }
        if (/^tel:/i.test(href)) {
            addPhone(d, decodeURIComponent(href), 'tel', pageUrl, opts.phoneCountry);
            return;
        }
        let abs: string;
        try {
            abs = new URL(href, pageUrl).toString();
        } catch {
            return;
        }
        const s = classifySocial(abs);
        if (s) (d.socials.get(s.network) ?? d.socials.set(s.network, new Set()).get(s.network)!).add(s.url);
        d.links.push({ url: abs, text: $(el).text().trim().slice(0, 80) });
    });
    const og = $('meta[property="og:site_name"]').attr('content')?.trim();
    if (og) d.companyNames.push(og);
    const appName = $('meta[name="application-name"]').attr('content')?.trim();
    if (appName) d.companyNames.push(appName);
    const title = $('title').first().text().trim();
    if (title) d.companyNames.push(`__title__${title}`);
    const desc =
        $('meta[name="description"]').attr('content')?.trim() ??
        $('meta[property="og:description"]').attr('content')?.trim();
    if (desc) d.descriptions.push(desc);
    $('address').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t.length >= 10 && t.length <= 250) d.addresses.push(t);
    });
    $('script,style,noscript,svg').remove();
    $('body *').append(' '); // keep adjacent elements from gluing words together
    const text = $('body').text().replace(/\s+/g, ' ');
    for (const e of extractEmails(text)) if (!d.emails.has(e)) d.emails.set(e, pageUrl);
    try {
        const found = opts.phoneCountry
            ? findPhoneNumbersInText(text, { defaultCountry: opts.phoneCountry as CountryCode })
            : findPhoneNumbersInText(text).filter((p) => text.slice(p.startsAt, p.endsAt).trim().startsWith('+'));
        for (const p of found.slice(0, 20)) {
            if (!p.number.isValid()) continue;
            if (!d.phones.has(p.number.number))
                d.phones.set(p.number.number, {
                    raw: text.slice(p.startsAt, p.endsAt).trim(),
                    source_url: pageUrl,
                    source: 'text',
                });
        }
    } catch {
        /* ignore */
    }
}

const CONTACT_WORDS =
    /contact|kontakt|contacto|contatti|contato|about|ueber-uns|uber-uns|über|a-propos|qui-sommes|chi-siamo|impressum|imprint|legal-notice|mentions-legales|aviso-legal|team|company|unternehmen|get-in-touch|reach-us|support|locations?|offices?/i;

/** Pick the most relevant same-site pages (contact/about/imprint first). */
export function pickPages(links: { url: string; text: string }[], home: URL, max: number): string[] {
    const base = home.hostname.replace(/^www\./, '');
    const scored = new Map<string, number>();
    for (const l of links) {
        let u: URL;
        try {
            u = new URL(l.url);
        } catch {
            continue;
        }
        if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base) continue;
        if (/\.(?:pdf|jpe?g|png|gif|svg|zip|mp4|webp|docx?|xlsx?)$/i.test(u.pathname)) continue;
        u.hash = '';
        u.search = '';
        const key = u.toString();
        if (key === home.toString() || u.pathname === '/') continue;
        const hay = `${u.pathname} ${l.text}`;
        if (!CONTACT_WORDS.test(hay)) continue;
        let score = 1;
        if (/contact|kontakt|contacto|contatti|contato|get-in-touch|reach-us/i.test(hay)) score += 5;
        if (/impressum|imprint|legal-notice|mentions-legales|aviso-legal/i.test(hay)) score += 4;
        if (/about|ueber|uber|über|a-propos|qui-sommes|chi-siamo|company|unternehmen/i.test(hay)) score += 3;
        score -= u.pathname.split('/').filter(Boolean).length * 0.5;
        scored.set(key, Math.max(scored.get(key) ?? -99, score));
    }
    return [...scored.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([u]) => u);
}

/** Choose a clean company name from collected candidates. */
export function pickCompanyName(cands: string[], domain: string): string | null {
    const root = domain
        .replace(/^www\./, '')
        .split('.')[0]
        .toLowerCase();
    const real = cands.filter((c) => !c.startsWith('__title__') && c.length <= 120);
    if (real.length) return real[0];
    const title = cands.find((c) => c.startsWith('__title__'))?.slice(9);
    if (!title) return null;
    const parts = title
        .split(/\s+[|–—·•:-]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const match = parts.find((p) =>
        p
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .includes(root),
    );
    return (match ?? parts[parts.length - 1] ?? title).slice(0, 120);
}
