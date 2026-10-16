import { createRequire } from 'node:module';

type RobotsFactory = (
    url: string,
    txt: string,
) => { isAllowed(u: string, ua?: string): boolean | undefined; getCrawlDelay(ua?: string): number | undefined };
const robotsParser = createRequire(import.meta.url)('robots-parser') as RobotsFactory;

export const USER_AGENT = 'FairqueryBot/1.0 (+https://apify.com/fairquery; contact-enrichment, respects robots.txt)';
const MAX_HTML = 3 * 1024 * 1024;

export interface Fetched {
    url: string;
    status: number;
    html: string | null;
}

export async function fetchPage(url: string, timeoutMs: number): Promise<Fetched> {
    const res = await fetch(url, {
        headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-language': 'en;q=0.9,*;q=0.5',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !/html|xml/i.test(ct)) {
        await res.body?.cancel().catch(() => undefined);
        return { url: res.url || url, status: res.status, html: null };
    }
    const reader = res.body?.getReader();
    if (!reader) return { url: res.url || url, status: res.status, html: '' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > MAX_HTML) {
            await reader.cancel().catch(() => undefined);
            break;
        }
    }
    return { url: res.url || url, status: res.status, html: Buffer.concat(chunks).toString('utf8') };
}

export interface Robots {
    isAllowed(url: string): boolean;
    crawlDelaySecs: number | null;
    status: 'ok' | 'missing' | 'unreachable-disallow-all' | 'network-error';
}

/** RFC 9309: 4xx = no restrictions; 5xx/network error = treat as full disallow. */
export async function loadRobots(origin: string, timeoutMs: number): Promise<Robots> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
        const res = await fetch(robotsUrl, {
            headers: { 'user-agent': USER_AGENT },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 400 && res.status < 500)
            return { isAllowed: () => true, crawlDelaySecs: null, status: 'missing' };
        if (!res.ok) return { isAllowed: () => false, crawlDelaySecs: null, status: 'unreachable-disallow-all' };
        const txt = (await res.text()).slice(0, 500_000);
        const r = robotsParser(robotsUrl, txt);
        return {
            isAllowed: (u: string) => r.isAllowed(u, 'FairqueryBot') !== false,
            crawlDelaySecs: r.getCrawlDelay('FairqueryBot') ?? null,
            status: 'ok',
        };
    } catch {
        return { isAllowed: () => false, crawlDelaySecs: null, status: 'network-error' };
    }
}

export function normalizeDomain(raw: string): string | null {
    let s = raw.trim().toLowerCase();
    if (!s) return null;
    if (s.includes('@') && !s.includes('/')) s = s.split('@').pop()!;
    if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
    try {
        const h = new URL(s).hostname.replace(/^www\./, '').replace(/\.$/, '');
        return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || h.startsWith('xn--') ? h : null;
    } catch {
        return null;
    }
}

export const sleep = (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });
