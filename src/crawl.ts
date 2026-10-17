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

/**
 * Per-request deadline linked to an optional outer (per-domain) signal.
 * Uses a plain AbortController + strongly referenced setTimeout instead of AbortSignal.timeout()/AbortSignal.any():
 * those can be garbage-collected before firing in Node, which made a stuck request never abort.
 * Every await is also raced against the abort, so a request whose socket ignores the abort still returns.
 */
export class Deadline {
    readonly ctrl = new AbortController();
    private readonly timer: NodeJS.Timeout;
    private readonly onOuter = () => this.ctrl.abort(new Error('Request aborted (domain time limit)'));
    readonly aborted: Promise<never>;

    constructor(
        timeoutMs: number,
        private readonly outer?: AbortSignal,
    ) {
        this.timer = setTimeout(() => this.ctrl.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
        if (outer) {
            if (outer.aborted) this.onOuter();
            else outer.addEventListener('abort', this.onOuter, { once: true });
        }
        this.aborted = new Promise<never>((_, reject) => {
            const fail = () => reject(this.ctrl.signal.reason ?? new Error('Request aborted'));
            if (this.ctrl.signal.aborted) fail();
            else this.ctrl.signal.addEventListener('abort', fail, { once: true });
        });
        this.aborted.catch(() => undefined); // never an unhandled rejection
    }

    get signal(): AbortSignal {
        return this.ctrl.signal;
    }

    /** Resolves like p, or rejects as soon as the deadline fires. */
    async race<T>(p: Promise<T>): Promise<T> {
        return Promise.race([p, this.aborted]);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.outer?.removeEventListener('abort', this.onOuter);
    }
}

export async function fetchPage(url: string, timeoutMs: number, outer?: AbortSignal): Promise<Fetched> {
    const dl = new Deadline(timeoutMs, outer);
    try {
        const res = await dl.race(
            fetch(url, {
                headers: {
                    'user-agent': USER_AGENT,
                    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
                    'accept-language': 'en;q=0.9,*;q=0.5',
                },
                redirect: 'follow',
                signal: dl.signal,
            }),
        );
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok || !/html|xml/i.test(ct)) {
            res.body?.cancel().catch(() => undefined);
            return { url: res.url || url, status: res.status, html: null };
        }
        const reader = res.body?.getReader();
        if (!reader) return { url: res.url || url, status: res.status, html: '' };
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await dl.race(reader.read());
                if (done) break;
                chunks.push(value);
                total += value.length;
                if (total > MAX_HTML) break;
            }
        } finally {
            reader.cancel().catch(() => undefined);
        }
        return { url: res.url || url, status: res.status, html: Buffer.concat(chunks).toString('utf8') };
    } finally {
        dl.dispose();
    }
}

export interface Robots {
    isAllowed(url: string): boolean;
    crawlDelaySecs: number | null;
    status: 'ok' | 'missing' | 'unreachable-disallow-all' | 'network-error';
}

/** RFC 9309: 4xx = no restrictions; 5xx/network error = treat as full disallow. */
export async function loadRobots(origin: string, timeoutMs: number, outer?: AbortSignal): Promise<Robots> {
    const robotsUrl = `${origin}/robots.txt`;
    const dl = new Deadline(timeoutMs, outer);
    try {
        const res = await dl.race(
            fetch(robotsUrl, {
                headers: { 'user-agent': USER_AGENT },
                redirect: 'follow',
                signal: dl.signal,
            }),
        );
        if (res.status >= 400 && res.status < 500)
            return { isAllowed: () => true, crawlDelaySecs: null, status: 'missing' };
        if (!res.ok) return { isAllowed: () => false, crawlDelaySecs: null, status: 'unreachable-disallow-all' };
        const txt = (await dl.race(res.text())).slice(0, 500_000);
        const r = robotsParser(robotsUrl, txt);
        return {
            isAllowed: (u: string) => r.isAllowed(u, 'FairqueryBot') !== false,
            crawlDelaySecs: r.getCrawlDelay('FairqueryBot') ?? null,
            status: 'ok',
        };
    } catch {
        return { isAllowed: () => false, crawlDelaySecs: null, status: 'network-error' };
    } finally {
        dl.dispose();
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

export const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });
