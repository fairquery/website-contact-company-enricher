#!/usr/bin/env node
/**
 * Fairquery stdio MCP server for Apify Actor fairquery/website-contact-company-enricher.
 * Tools: enrich_domains (runs the Actor, needs APIFY_TOKEN; waitForFinish=false starts it in the background),
 * get_enrichment_results (free read of such a run) and normalize_domains (free, local, with cost preview).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callActorTool, compact, fail, getToken, ok, readRun, READ_ONLY_LOCAL, READ_ONLY_REMOTE, RunLookupError, startActor, TOKEN_MISSING } from './common.js';

const ACTOR_ID = 'fairquery~website-contact-company-enricher';
const PRICE_PER_DOMAIN = 0.003;
const START_FEE = 0.00005;
const MAX_DOMAINS_PER_RUN = 1000;

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

const server = new McpServer({ name: 'fairquery-contact-enricher', version: '1.1.0' });

server.registerTool(
    'enrich_domains',
    {
        title: 'Enrich domains with public business contacts',
        description: [
            'WHAT: For each company domain, crawl the homepage plus up to N contact/about/imprint pages (plain HTTP, robots.txt respected, polite per-site delay) and return one row with company_name, description, business/role emails (MX, disposable and typo validated), phones (E.164), social profiles (LinkedIn company, X, Facebook, Instagram, YouTube, GitHub...), postal address and mail-domain info.',
            'WHEN TO USE: enriching a lead/CRM list of company websites with public contact data; finding the official contact email or address of a business.',
            'WHEN NOT TO USE: to clean/dedupe a messy list first or preview what will be billed, call normalize_domains (free). Not for finding personal emails of individuals, LinkedIn people search, or JavaScript-only sites that need a browser.',
            'COST: paid. Runs Apify Actor fairquery/website-contact-company-enricher with your APIFY_TOKEN; pay-per-event "domain-enriched": $0.003 per domain that returns a result row. Unreachable, blocked or invalid domains are free. 100 domains ~ $0.30. ~2-10 s per domain.',
            'RETURNS: one type="domain" row per enriched domain (fields are null or empty when not published on the crawled pages) or free type="error" rows (code, message, retryable); with waitForFinish=false, items is empty and run holds run_id for get_enrichment_results.',
            'PARAMETERS: domains: entries are split on commas, semicolons and newlines, then each is reduced to its hostname (scheme, path, port and a leading "www." removed; for an email the part after @ is used; other subdomains are kept, so "shop.acme.com" and "acme.com" are separate) and deduplicated, so you pay once per unique enriched domain; unparseable entries give free INVALID_DOMAIN rows (max 1000 domains per run; extras get a free MAX_DOMAINS_EXCEEDED row). Run normalize_domains first to preview exactly what will be billed (billable_count, estimated_max_cost_usd). waitForFinish=false returns at once with run.run_id and the run keeps going in your Apify account (same price); use it for lists over ~100 domains, which may not finish within this call\'s 280 s wait, then poll get_enrichment_results. maxPagesPerDomain changes run time and coverage, never the price; 1 = homepage only, 3-5 usually finds the contact/imprint page. emailScope only filters which found addresses are returned: "role" keeps generic mailboxes (info@, sales@, support@...) on any domain, "business" adds named addresses on the company\'s own domain, "all" also keeps third-party/personal addresses - choose the narrowest scope your lawful basis allows. validateEmails=false skips only the DNS part: disposable/typo checks still run locally, has_mx and mail_domain become null and clean addresses get verdict "unknown" instead of "valid"; checkSpfDmarc adds SPF/DMARC for the company mail domain and has no effect when validateEmails=false. defaultPhoneCountry widens phone extraction to national-format numbers in page text (e.g. "030 1234567" with "DE"); without it only tel: links, JSON-LD and +international numbers are parsed, all returned as E.164.',
            'EXAMPLE: {"domains":["stripe.com","https://basecamp.com/about"],"maxPagesPerDomain":3} -> 2 domain rows.',
        ].join('\n'),
        inputSchema: {
            domains: z
                .array(z.string().min(1))
                .min(1)
                .describe('Required. 1+ non-empty strings: domains, website URLs or email addresses (the domain part is used); comma/semicolon/newline lists are split; deduplicated; billed once per enriched domain. Example: ["apify.com","https://stripe.com","info@basecamp.com"]'),
            maxPagesPerDomain: z
                .number()
                .int()
                .min(1)
                .max(15)
                .optional()
                .describe('Optional integer 1-15, default 5. Pages fetched per domain: homepage plus the best contact/about/imprint pages linked from it; affects time, not price. Example: 3'),
            emailScope: z
                .enum(['role', 'business', 'all'])
                .optional()
                .describe('Optional, one of "role" | "business" | "all", default "role" (GDPR-friendly). "role" = generic mailboxes only (info@, sales@, support@); "business" = also named addresses on the company\'s own domain; "all" = every address published on the pages. Example: "business"'),
            validateEmails: z
                .boolean()
                .optional()
                .describe('Optional boolean, default true. true runs a DNS-over-HTTPS MX lookup per email domain (no SMTP probing); false skips DNS (disposable/typo checks still run, clean emails get verdict "unknown").'),
            checkSpfDmarc: z
                .boolean()
                .optional()
                .describe('Optional boolean, default false. true adds SPF/DMARC presence and DMARC policy (none|quarantine|reject) for the company mail domain to mail_domain; requires validateEmails=true.'),
            defaultPhoneCountry: z
                .string()
                .length(2)
                .optional()
                .describe('Optional, no default. ISO 3166-1 alpha-2 country code, exactly 2 letters, e.g. "US", "DE". When set, national-format numbers in page text are also parsed; otherwise only tel: links, JSON-LD and +international numbers.'),
            waitForFinish: z
                .boolean()
                .optional()
                .describe('Optional boolean, default true. true waits up to 280 s and returns the rows; false starts the run and returns immediately with run.run_id (poll get_enrichment_results). Same price either way. Example: false'),
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=domain or type=error'),
            count: z.number().describe('Number of rows in items'),
            run: z.record(z.unknown()).optional().describe('Only with waitForFinish=false: run_id, status, dataset_id, console_url'),
        },
        annotations: { title: 'Enrich domains', ...READ_ONLY_REMOTE },
    },
    async ({ waitForFinish, ...args }) => {
        if (waitForFinish !== false) return callActorTool(ACTOR_ID, args);
        const token = getToken();
        if (!token) return TOKEN_MISSING();
        try {
            const run = await startActor(ACTOR_ID, compact(args), token);
            return ok({ items: [], count: 0, run });
        } catch (e) {
            return fail('APIFY_ACTOR_RUN_FAILED', e instanceof Error ? e.message : String(e));
        }
    },
);

server.registerTool(
    'get_enrichment_results',
    {
        title: 'Get results of a background enrichment run (free)',
        description: [
            'WHAT: Read the status and result rows of an enrich_domains run started with waitForFinish=false, one page at a time.',
            'WHEN TO USE: after enrich_domains returned run.run_id, to poll until finished is true and page through the rows; rows already written are returned while the run is still RUNNING.',
            'WHEN NOT TO USE: to start an enrichment (enrich_domains) or to preview cost (normalize_domains). Cannot read runs of other Actors.',
            'BEHAVIOR: GET requests to the Apify API only (actor, run, dataset); never starts, aborts or re-bills a run. Typically <1 s. Poll every 10-30 s; a run works on 5 domains at a time, ~2-10 s each.',
            'COST: free; needs the APIFY_TOKEN that started the run. Reading charges no Actor event (the run was billed per enriched domain when it ran).',
            'RETURNS: run (run_id, status, finished) plus one page of the same rows enrich_domains returns; Errors: APIFY_TOKEN_MISSING, RUN_NOT_FOUND, RUN_NOT_FOR_THIS_ACTOR, APIFY_TOKEN_INVALID, APIFY_RUN_LOOKUP_FAILED / APIFY_DATASET_READ_FAILED (retryable).',
            'PARAMETERS: runId is run.run_id from enrich_domains (also shown in the Apify console URL). status is READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT; finished=true for the last four, after which total no longer changes. A FAILED or TIMED-OUT run still returns the rows it wrote. offset/limit page the rows in write order; total counts all rows written so far, so keep calling with nextOffset until it is null and finished is true.',
            'EXAMPLE: {"runId":"a1B2c3D4e5F6g7H8i"} -> {"run":{"status":"SUCCEEDED","finished":true},"count":1,"total":1,"items":[{"type":"domain","domain":"apify.com",...}]}',
        ].join('\n'),
        inputSchema: {
            runId: z.string().min(5).max(64).regex(/^[A-Za-z0-9]+$/).describe('Required. Apify run ID (letters and digits) from enrich_domains run.run_id. Example: "a1B2c3D4e5F6g7H8i"'),
            offset: z.number().int().min(0).optional().describe('Optional integer >= 0, default 0; use nextOffset from the previous page. Example: 100'),
            limit: z.number().int().min(1).max(1000).optional().describe('Optional page size, integer 1-1000, default 100. Example: 250'),
        },
        outputSchema: {
            run: z.record(z.unknown()).describe('run_id, status, finished, dataset_id, started_at, finished_at, console_url'),
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=domain or type=error'),
            count: z.number().describe('Rows in this page'),
            total: z.number().describe('Rows written by the run so far'),
            nextOffset: z.number().nullable().describe('Offset of the next page, or null'),
        },
        annotations: { title: 'Get enrichment run results (free)', ...READ_ONLY_REMOTE },
    },
    async ({ runId, offset = 0, limit = 100 }) => {
        const token = getToken();
        if (!token) return TOKEN_MISSING();
        try {
            const { info, items, total } = await readRun(ACTOR_ID, runId, token, offset, limit);
            const next = offset + items.length < total ? offset + items.length : null;
            return ok({ run: info, items, count: items.length, total, nextOffset: next });
        } catch (e) {
            if (e instanceof RunLookupError) return fail(e.code, e.message + (e.retryable ? ' (retryable)' : ''));
            return fail('APIFY_RUN_LOOKUP_FAILED', (e instanceof Error ? e.message : String(e)) + ' (retryable)');
        }
    },
);

server.registerTool(
    'normalize_domains',
    {
        title: 'Normalize and dedupe domains (free)',
        description: [
            'WHAT: Turn URLs, email addresses and messy strings into bare registrable hostnames (lowercase, no scheme/path/www), remove duplicates and list entries that are not valid domains.',
            'WHEN TO USE: before enrich_domains, to clean an input list and see exactly which domains would be billed.',
            'WHEN NOT TO USE: to get contacts, company names or check that a site is reachable - use enrich_domains. Does no DNS lookup.',
            'COST: free; local, no network, no APIFY_TOKEN.',
            'RETURNS: domains is exactly the list enrich_domains would bill; billable_count and estimated_max_cost_usd preview that bill; invalid entries would only get free error rows there.',
            'PARAMETERS: inputs: each element may hold one value or a newline/comma/semicolon-separated list; pieces are trimmed and empty ones dropped. Each piece is lowercased and reduced to its hostname (scheme, path, query, port and a leading "www." removed; for a bare email the part after @ is used); other subdomains are kept, so "blog.acme.com" and "acme.com" stay separate. A piece is invalid unless the host has a dot and a 2+ letter TLD (punycode xn-- hosts accepted). domains keeps first-seen order and duplicates_removed counts repeats after normalization. This is exactly the normalization enrich_domains applies: billable_count = min(domains.length, 1000 per run) and estimated_max_cost_usd = billable_count x $0.003 + the $0.00005 start fee, the most passing the same inputs to enrich_domains can cost (unreachable domains lower it). An empty array is accepted and returns empty lists.',
            'EXAMPLE: {"inputs":["https://www.Stripe.com/pricing","info@stripe.com","not a domain"]} -> {"domains":["stripe.com"],"invalid":["not a domain"],"duplicates_removed":1,"billable_count":1,"estimated_max_cost_usd":0.00305}',
        ].join('\n'),
        inputSchema: {
            inputs: z
                .array(z.string())
                .describe('Required array (may be empty) of strings: URLs, domains or email addresses; each entry may also be a newline/comma/semicolon-separated list. Example: ["https://www.acme.com/contact","sales@acme.com","acme.com, beta.io"]'),
        },
        outputSchema: {
            domains: z.array(z.string()).describe('Unique normalized domains, input order'),
            invalid: z.array(z.string()).describe('Entries that could not be parsed as a domain'),
            duplicates_removed: z.number().describe('Count of duplicate entries dropped'),
            billable_count: z.number().describe('Domains one enrich_domains run would process and could bill (max 1000)'),
            estimated_max_cost_usd: z.number().describe('Upper bound in USD for enrich_domains on the same inputs'),
        },
        annotations: { title: 'Normalize domains', ...READ_ONLY_LOCAL },
    },
    async ({ inputs }) => {
        const out = new Set<string>();
        const invalid: string[] = [];
        let dup = 0;
        for (const raw of inputs.flatMap((s) => s.split(/[\n,;]+/)).map((s) => s.trim()).filter(Boolean)) {
            const d = normalizeDomain(raw);
            if (!d) invalid.push(raw);
            else if (out.has(d)) dup += 1;
            else out.add(d);
        }
        const billable = Math.min(out.size, MAX_DOMAINS_PER_RUN);
        const maxCost = billable ? Math.round((billable * PRICE_PER_DOMAIN + START_FEE) * 1e5) / 1e5 : 0;
        return ok({ domains: [...out], invalid, duplicates_removed: dup, billable_count: billable, estimated_max_cost_usd: maxCost });
    },
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('fairquery-contact-enricher MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
