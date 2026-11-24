import { Actor, log } from 'apify';

import {
    isDisposable,
    isFreeProvider,
    isRole,
    mailProviderOf,
    parseEmail,
    suggestDomain,
    verdictOf,
} from './checks.js';
import { fetchPage, loadRobots, normalizeDomain, sleep } from './crawl.js';
import { runWithDeadline } from './deadline.js';
import { DohClient, type DomainDns, lookupDomain } from './dns.js';
import { Emitter } from './emitter.js';
import { emptyPageData, parsePage, pickCompanyName, pickPages } from './extract.js';
import { SCHEMA_VERSION } from './types.js';

interface Input {
    domains?: string[];
    maxPagesPerDomain?: number;
    emailScope?: 'role' | 'business' | 'all';
    validateEmails?: boolean;
    checkSpfDmarc?: boolean;
    defaultPhoneCountry?: string;
    domainConcurrency?: number;
    requestDelayMs?: number;
    requestTimeoutSecs?: number;
    domainTimeoutSecs?: number;
    maxDomains?: number;
}

const EVENT = 'domain-enriched';

await Actor.init();
const startedAt = new Date().toISOString();
// Batch size 1: every finished domain is pushed and charged immediately, so a run that hits its
// timeout or is aborted never loses completed (billable) work.
const emitter = new Emitter(1);
let aborting = false;
Actor.on('aborting', async () => {
    aborting = true;
    await emitter.flush();
});

const input = ((await Actor.getInput<Input>()) ?? {}) as Input;
const maxPages = Math.min(Math.max(input.maxPagesPerDomain ?? 5, 1), 15);
const scope = input.emailScope ?? 'role';
const validate = input.validateEmails ?? true;
const spfDmarc = input.checkSpfDmarc ?? false;
const phoneCountry = input.defaultPhoneCountry?.trim().toUpperCase() || undefined;
const concurrency = Math.min(Math.max(input.domainConcurrency ?? 5, 1), 20);
const delayMs = Math.max(input.requestDelayMs ?? 1000, 250);
const timeoutMs = Math.min(Math.max(input.requestTimeoutSecs ?? 15, 5), 60) * 1000;
const maxDomains = input.maxDomains ?? 1000;
// Hard wall-clock budget per domain (all pages, robots.txt and DNS checks together).
const domainTimeoutMs = Math.min(Math.max(input.domainTimeoutSecs ?? 40, 15), 120) * 1000;
// Stop starting new domains shortly before the platform run timeout.
const runDeadline = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : NaN;
const RUN_SAFETY_MS = domainTimeoutMs + 20_000;
const nearRunTimeout = () => !Number.isNaN(runDeadline) && Date.now() > runDeadline - RUN_SAFETY_MS;

const counters = {
    domains_enriched: 0,
    errors: 0,
    pages_fetched: 0,
    pages_blocked_by_robots: 0,
    emails_found: 0,
    emails_excluded_by_scope: 0,
    duplicates_skipped: 0,
    domains_timed_out: 0,
    domains_skipped_run_timeout: 0,
};
const doh = new DohClient();
const dnsCache = new Map<string, Promise<DomainDns | null>>();

const seen = new Set<string>();
const domains: { input: string; domain: string }[] = [];
for (const raw of (input.domains ?? [])
    .flatMap((d) => String(d).split(/[\n,;]+/))
    .map((d) => d.trim())
    .filter(Boolean)) {
    const d = normalizeDomain(raw);
    if (!d) {
        await pushError('INVALID_DOMAIN', `Not a valid domain or URL: ${raw.slice(0, 200)}`, false, raw, null);
        continue;
    }
    if (seen.has(d)) {
        counters.duplicates_skipped += 1;
        continue;
    }
    seen.add(d);
    domains.push({ input: raw, domain: d });
}
if (!domains.length && !counters.errors)
    await pushError('INPUT_EMPTY', 'Input.domains must contain at least one domain.', false, null, null);
if (domains.length > maxDomains) {
    await pushError(
        'MAX_DOMAINS_EXCEEDED',
        `${domains.length} domains supplied; only the first ${maxDomains} were processed.`,
        false,
        null,
        null,
    );
    domains.length = maxDomains;
}

log.info('Contact enricher starting', { domains: domains.length, maxPages, scope, concurrency });

let next = 0;
await Promise.all(
    Array.from({ length: Math.min(concurrency, domains.length) }, async () => {
        while (next < domains.length && !aborting && !emitter.limitReached) {
            if (nearRunTimeout()) break;
            const item = domains[next++];
            try {
                await enrichWithDeadline(item.input, item.domain);
            } catch (e) {
                await pushError(
                    'ENRICH_FAILED',
                    e instanceof Error ? e.message : String(e),
                    true,
                    item.input,
                    item.domain,
                );
            }
        }
    }),
);

if (next < domains.length && nearRunTimeout() && !aborting) {
    const left = domains.length - next;
    counters.domains_skipped_run_timeout = left;
    await pushError(
        'RUN_TIMEOUT_NEAR',
        `Run timeout approaching: ${left} domain(s) were not processed (not charged). Re-run them or raise the run timeout.`,
        true,
        null,
        null,
    );
}

await emitter.flush();
await Actor.setValue('RUN_SUMMARY', {
    schema_version: SCHEMA_VERSION,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    domains_requested: domains.length,
    ...counters,
    dns_requests: doh.requestCount,
    charged_events: emitter.charged,
    settings: {
        maxPagesPerDomain: maxPages,
        emailScope: scope,
        validateEmails: validate,
        checkSpfDmarc: spfDmarc,
        defaultPhoneCountry: phoneCountry ?? null,
        domainConcurrency: concurrency,
        requestDelayMs: delayMs,
        domainTimeoutSecs: domainTimeoutMs / 1000,
    },
});
await Actor.exit();

async function dnsFor(domain: string): Promise<DomainDns | null> {
    let p = dnsCache.get(domain);
    if (!p) {
        p = lookupDomain(doh, domain, spfDmarc).catch(() => null);
        dnsCache.set(domain, p);
    }
    return p;
}

/**
 * Runs enrich() under a hard per-domain wall-clock limit. At the limit the domain's requests are aborted and
 * the row is built from whatever was collected (charged only if the homepage was fetched). If enrich() still
 * does not settle shortly after (a non-abortable await), the domain gets an uncharged DOMAIN_TIMEOUT error row
 * and the worker moves on, so one site can never hang the run.
 */
/** First caller wins: exactly one row (data or error) per domain. */
function claim(state: { done: boolean }): boolean {
    if (state.done) return false;
    Object.assign(state, { done: true });
    return true;
}

async function enrichWithDeadline(rawInput: string, domain: string): Promise<void> {
    const state = { done: false, phase: 'start' };
    const r = await runWithDeadline(async (signal) => enrich(rawInput, domain, signal, state), domainTimeoutMs, 10_000);
    if (r === 'hard-timeout' && claim(state)) {
        // a late enrich() can no longer emit a second row
        counters.domains_timed_out += 1;
        await pushError(
            'DOMAIN_TIMEOUT',
            `Domain did not finish within ${domainTimeoutMs / 1000 + 10} s (stuck at: ${state.phase}); skipped (not charged).`,
            true,
            rawInput,
            domain,
        );
    }
}

async function enrich(
    rawInput: string,
    domain: string,
    signal: AbortSignal,
    state: { done: boolean; phase: string },
): Promise<void> {
    const phase = (p: string) => Object.assign(state, { phase: p });
    const startUrls = [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`];
    const data = emptyPageData();
    const crawled = new Set<string>();
    let blocked = 0;
    let robotsStatus = 'ok';
    let home: URL | null = null;
    let lastErr = '';
    let lastFetch = 0;
    let crawlDelay = delayMs;

    const polite = async () => {
        const wait = lastFetch + crawlDelay - Date.now();
        if (wait > 0) await sleep(wait);
        lastFetch = Date.now();
    };

    for (const start of startUrls) {
        if (signal.aborted) {
            lastErr = lastErr || `Domain time limit (${domainTimeoutMs / 1000} s) reached`;
            break;
        }
        const { origin } = new URL(start);
        phase(`robots ${origin}`);
        const robots = await loadRobots(origin, timeoutMs, signal);
        robotsStatus = robots.status;
        if (robots.status === 'network-error') {
            lastErr = `Site unreachable: ${start}`;
            continue;
        }
        if (robots.crawlDelaySecs) crawlDelay = Math.min(Math.max(delayMs, robots.crawlDelaySecs * 1000), 10_000);
        if (!robots.isAllowed(start)) {
            blocked += 1;
            lastErr =
                robots.status === 'ok'
                    ? 'Homepage disallowed by robots.txt'
                    : 'robots.txt unreachable (5xx/network): treated as disallow per RFC 9309';
            if (robots.status === 'ok') break;
            continue;
        }
        try {
            await polite();
            phase(`homepage ${start}`);
            const f = await fetchPage(start, timeoutMs, signal);
            counters.pages_fetched += 1;
            if (!f.html) {
                lastErr = `Homepage HTTP ${f.status}`;
                continue;
            }
            home = new URL(f.url);
            crawled.add(f.url);
            phase('parse homepage');
            parsePage(f.html, f.url, data, { phoneCountry });
            const finalRobots =
                new URL(f.url).origin === origin ? robots : await loadRobots(new URL(f.url).origin, timeoutMs, signal);
            for (const u of pickPages(data.links, home, maxPages - 1)) {
                if (aborting || signal.aborted) break;
                if (crawled.has(u)) continue;
                if (!finalRobots.isAllowed(u)) {
                    blocked += 1;
                    continue;
                }
                try {
                    await polite();
                    if (signal.aborted) break;
                    phase(`page ${u}`);
                    const p = await fetchPage(u, timeoutMs, signal);
                    counters.pages_fetched += 1;
                    if (p.html && !crawled.has(p.url)) {
                        crawled.add(p.url);
                        parsePage(p.html, p.url, data, { phoneCountry });
                    }
                } catch {
                    /* skip page */
                }
            }
            break;
        } catch (e) {
            if (e instanceof Error) {
                lastErr = e.cause instanceof Error ? e.cause.message : e.message;
            } else {
                lastErr = String(e);
            }
        }
    }
    counters.pages_blocked_by_robots += blocked;
    const timedOut = signal.aborted;

    if (!home) {
        if (!claim(state)) return;
        if (timedOut) counters.domains_timed_out += 1;
        let code = blocked ? 'BLOCKED_BY_ROBOTS' : 'SITE_UNREACHABLE';
        if (timedOut) code = 'DOMAIN_TIMEOUT';
        await pushError(
            code,
            timedOut
                ? `Homepage not fetched within the ${domainTimeoutMs / 1000} s domain time limit`
                : lastErr || 'Homepage could not be fetched',
            !blocked || timedOut,
            rawInput,
            domain,
        );
        return;
    }

    const siteRoot = home.hostname.replace(/^www\./, '');
    const emails = [];
    for (const [email, src] of data.emails) {
        const p = parseEmail(email);
        if (!p) continue;
        counters.emails_found += 1;
        const role = isRole(p.local);
        const onDomain =
            p.domain === siteRoot || p.domain.endsWith(`.${siteRoot}`) || siteRoot.endsWith(`.${p.domain}`);
        const allowed = scope === 'all' || role || (scope === 'business' && onDomain);
        if (!allowed) {
            counters.emails_excluded_by_scope += 1;
            continue;
        }
        phase(`dns ${p.domain}`);
        const dns = validate && !signal.aborted ? await dnsFor(p.domain) : null;
        const disposable = isDisposable(p.domain);
        const free = isFreeProvider(p.domain);
        const typo = suggestDomain(p.domain);
        const v = verdictOf({
            syntaxValid: true,
            disposable,
            role,
            free,
            domainExists: dns ? dns.exists : null,
            hasMx: dns ? dns.mx.length > 0 : null,
            nullMx: dns?.nullMx ?? false,
            implicitMx: dns?.implicitMx ?? false,
            didYouMean: typo,
            allowRole: true,
            allowDisposable: false,
            allowFree: true,
        });
        emails.push({
            email: p.email,
            source_url: src,
            is_role_account: role,
            on_company_domain: onDomain,
            is_free_provider: free,
            is_disposable: disposable,
            verdict: v.verdict,
            reasons: v.reasons,
            has_mx: dns ? dns.mx.length > 0 : null,
            mail_provider: dns ? mailProviderOf(dns.mx.map((m) => m.exchange)) : null,
        });
        if (emails.length >= 25) break;
    }
    emails.sort(
        (a, b) =>
            Number(b.on_company_domain) - Number(a.on_company_domain) ||
            Number(b.is_role_account) - Number(a.is_role_account),
    );
    phase(`dns ${siteRoot}`);
    const siteDns = validate && !signal.aborted ? await dnsFor(siteRoot) : null;
    phase('emit');
    const social: Record<string, string[]> = {};
    for (const [k, v] of data.socials) social[k] = [...v].slice(0, 5);
    const addresses = [...new Set(data.addresses)].slice(0, 5);
    const row = {
        schema_version: SCHEMA_VERSION,
        type: 'domain',
        input: rawInput,
        domain,
        final_url: home.toString(),
        enriched_at: new Date().toISOString(),
        company_name: pickCompanyName(data.companyNames, siteRoot),
        description: data.descriptions[0]?.slice(0, 500) ?? null,
        emails,
        primary_email: emails.find((e) => e.verdict !== 'invalid')?.email ?? null,
        phones: [...data.phones.entries()].slice(0, 10).map(([e164, p]) => ({ e164, ...p })),
        social_links: social,
        address: addresses[0] ?? null,
        addresses,
        mail_domain: siteDns
            ? {
                  has_mx: siteDns.mx.length > 0,
                  null_mx: siteDns.nullMx,
                  mail_provider: mailProviderOf(siteDns.mx.map((m) => m.exchange)),
                  has_spf: siteDns.spf,
                  has_dmarc: siteDns.dmarc,
                  dmarc_policy: siteDns.dmarcPolicy,
              }
            : null,
        pages_crawled: [...crawled],
        pages_blocked_by_robots: blocked,
        robots_txt: robotsStatus,
        email_scope: scope,
        // true if the per-domain time limit cut the crawl short; the row holds what was collected until then
        partial: timedOut,
    };
    if (!claim(state)) return;
    if (timedOut) counters.domains_timed_out += 1;
    await emitter.emit(row, EVENT);
    counters.domains_enriched += 1;
}

async function pushError(
    code: string,
    message: string,
    retryable: boolean,
    inputRaw: string | null,
    domain: string | null,
): Promise<void> {
    counters.errors += 1;
    await emitter.emit(
        {
            schema_version: SCHEMA_VERSION,
            type: 'error',
            code,
            message,
            retryable,
            input: inputRaw,
            domain,
            enriched_at: new Date().toISOString(),
        },
        null,
    );
}
