import { Deadline } from './crawl.js';
import { DOH_URL } from './types.js';

export class DnsError extends Error {
    constructor(
        message: string,
        public retryable: boolean,
    ) {
        super(message);
    }
}

interface DohAnswer {
    name: string;
    type: number;
    data: string;
}
interface DohResponse {
    Status: number;
    Answer?: DohAnswer[];
}

export const TYPE = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 } as const;

export function dohUrl(name: string, type: keyof typeof TYPE): string {
    return `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
}

/** DNS-over-HTTPS JSON client (Cloudflare). Status 0=NOERROR, 3=NXDOMAIN. */
export class DohClient {
    requestCount = 0;
    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async query(name: string, type: keyof typeof TYPE, attempt = 0): Promise<{ status: number; answers: DohAnswer[] }> {
        this.requestCount += 1;
        try {
            const dl = new Deadline(10_000);
            let res: Response;
            let j: DohResponse | null = null;
            try {
                res = await dl.race(
                    this.fetchImpl(dohUrl(name, type), {
                        headers: { accept: 'application/dns-json' },
                        signal: dl.signal,
                    }),
                );
                if (res.ok) j = (await dl.race(res.json())) as DohResponse;
                else res.body?.cancel().catch(() => undefined);
            } finally {
                dl.dispose();
            }
            if (!res.ok) {
                const retryable = res.status === 429 || res.status >= 500;
                if (retryable && attempt < 3) return this.retry(name, type, attempt);
                throw new DnsError(`DoH ${type} ${name} -> HTTP ${res.status}`, retryable);
            }
            if (!j) throw new DnsError(`DoH ${type} ${name}: empty response`, true);
            if (j.Status === 2 && attempt < 2) return this.retry(name, type, attempt); // SERVFAIL
            return { status: j.Status, answers: (j.Answer ?? []).filter((a) => a.type === TYPE[type]) };
        } catch (e) {
            if (e instanceof DnsError) throw e;
            if (attempt < 3) return this.retry(name, type, attempt);
            throw new DnsError(`DoH ${type} ${name} failed: ${e instanceof Error ? e.message : String(e)}`, true);
        }
    }

    private async retry(name: string, type: keyof typeof TYPE, attempt: number) {
        await new Promise<void>((r) => {
            setTimeout(r, 300 * 2 ** attempt);
        });
        return this.query(name, type, attempt + 1);
    }
}

export interface DomainDns {
    domain: string;
    exists: boolean;
    mx: { priority: number; exchange: string }[];
    nullMx: boolean;
    implicitMx: boolean;
    spf: boolean | null;
    dmarc: boolean | null;
    dmarcPolicy: string | null;
}

export function parseMx(answers: DohAnswer[]): { priority: number; exchange: string }[] {
    return answers
        .map((a) => {
            const [p, ex] = a.data.trim().split(/\s+/);
            return { priority: Number(p), exchange: (ex ?? '').replace(/\.$/, '').toLowerCase() };
        })
        .sort((a, b) => a.priority - b.priority);
}

export function txtValue(data: string): string {
    // DoH JSON returns TXT as quoted chunks: "v=spf1 " "include:..."
    const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
    return chunks ? chunks.map((c) => c.slice(1, -1)).join('') : data;
}

export async function lookupDomain(client: DohClient, domain: string, spfDmarc: boolean): Promise<DomainDns> {
    const mxRes = await client.query(domain, 'MX');
    const out: DomainDns = {
        domain,
        exists: mxRes.status !== 3,
        mx: parseMx(mxRes.answers),
        nullMx: false,
        implicitMx: false,
        spf: null,
        dmarc: null,
        dmarcPolicy: null,
    };
    if (!out.exists) return out;
    if (out.mx.length === 1 && out.mx[0].priority === 0 && (out.mx[0].exchange === '' || out.mx[0].exchange === '.')) {
        out.nullMx = true;
        out.mx = [];
    }
    if (!out.mx.length && !out.nullMx) {
        const [a, aaaa] = await Promise.all([client.query(domain, 'A'), client.query(domain, 'AAAA')]);
        out.implicitMx = a.answers.length > 0 || aaaa.answers.length > 0;
    }
    if (spfDmarc) {
        const [txt, dmarc] = await Promise.all([client.query(domain, 'TXT'), client.query(`_dmarc.${domain}`, 'TXT')]);
        out.spf = txt.answers.some((a) => /^v=spf1\b/i.test(txtValue(a.data)));
        const d = dmarc.answers.map((a) => txtValue(a.data)).find((t) => /^v=DMARC1\b/i.test(t));
        out.dmarc = Boolean(d);
        out.dmarcPolicy = d ? (/\bp=([a-z]+)/i.exec(d)?.[1]?.toLowerCase() ?? null) : null;
    }
    return out;
}
