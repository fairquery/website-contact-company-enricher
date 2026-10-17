#!/usr/bin/env node
/**
 * Fairquery stdio MCP server for Apify Actor fairquery/website-contact-company-enricher.
 * Tools: enrich_domains (runs the Actor, needs APIFY_TOKEN) and normalize_domains (free, local).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callActorTool, ok, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from './common.js';

const ACTOR_ID = 'fairquery~website-contact-company-enricher';

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

const server = new McpServer({ name: 'fairquery-contact-enricher', version: '1.0.2' });

server.registerTool(
    'enrich_domains',
    {
        title: 'Enrich domains with public business contacts',
        description: [
            'WHAT: For each company domain, crawl the homepage plus up to N contact/about/imprint pages (plain HTTP, robots.txt respected, polite per-site delay) and return one row with company_name, description, business/role emails (MX, disposable and typo validated), phones (E.164), social profiles (LinkedIn company, X, Facebook, Instagram, YouTube, GitHub...), postal address and mail-domain info.',
            'WHEN TO USE: enriching a lead/CRM list of company websites with public contact data; finding the official contact email or address of a business.',
            'WHEN NOT TO USE: to clean/dedupe a messy list first or preview what will be billed, call normalize_domains (free). Not for finding personal emails of individuals, LinkedIn people search, or JavaScript-only sites that need a browser.',
            'COST: paid. Runs Apify Actor fairquery/website-contact-company-enricher with your APIFY_TOKEN; pay-per-event "domain-enriched": $0.003 per domain that returns a result row. Unreachable, blocked or invalid domains are free. 100 domains ~ $0.30. ~2-10 s per domain.',
            'RETURNS: {count, items}. type="domain" row per domain: input, domain, final_url, company_name, description, emails[], primary_email, phones[] (E.164), social_links, address, addresses, mail_domain (MX/provider, SPF/DMARC if requested), pages_crawled, pages_blocked_by_robots, email_scope, enriched_at; or type="error" rows (code, message, retryable).',
            'PARAMETERS: domains: entries are split on commas, semicolons and newlines, then each is reduced to its hostname (scheme, path, port and a leading "www." removed; for an email the part after @ is used; other subdomains are kept, so "shop.acme.com" and "acme.com" are separate) and deduplicated, so you pay $0.003 once per unique enriched domain; unparseable entries give free INVALID_DOMAIN rows (max 1000 domains per run; extras get a free MAX_DOMAINS_EXCEEDED row). Run normalize_domains first to preview exactly what will be billed. maxPagesPerDomain changes run time and coverage, never the price; 1 = homepage only, 3-5 usually finds the contact/imprint page. emailScope only filters which found addresses are returned: "role" keeps generic mailboxes (info@, sales@, support@...) on any domain, "business" adds named addresses on the company\'s own domain, "all" also keeps third-party/personal addresses - choose the narrowest scope your lawful basis allows. validateEmails=false skips only the DNS part: disposable/typo checks still run locally, has_mx and mail_domain become null and clean addresses get verdict "unknown" instead of "valid"; checkSpfDmarc adds SPF/DMARC for the company mail domain and has no effect when validateEmails=false. defaultPhoneCountry widens phone extraction to national-format numbers in page text (e.g. "030 1234567" with "DE"); without it only tel: links, JSON-LD and +international numbers are parsed, all returned as E.164.',
            'EXAMPLE: {"domains":["stripe.com","https://basecamp.com/about"],"maxPagesPerDomain":3} -> 2 domain rows.',
        ].join('\n'),
        inputSchema: {
            domains: z
                .array(z.string().min(1))
                .min(1)
                .describe('Required. 1+ non-empty strings: domains, website URLs or email addresses (the domain part is used); comma/semicolon/newline lists are split; deduplicated; $0.003 per enriched domain. Example: ["apify.com","https://stripe.com","info@basecamp.com"]'),
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
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=domain or type=error'),
            count: z.number().describe('Number of rows in items'),
        },
        annotations: { title: 'Enrich domains', ...READ_ONLY_REMOTE },
    },
    async (args) => callActorTool(ACTOR_ID, args),
);

server.registerTool(
    'normalize_domains',
    {
        title: 'Normalize and dedupe domains (free)',
        description: [
            'WHAT: Turn URLs, email addresses and messy strings into bare registrable hostnames (lowercase, no scheme/path/www), remove duplicates and list entries that are not valid domains.',
            'WHEN TO USE: before enrich_domains, to clean an input list and see exactly which domains would be billed.',
            'WHEN NOT TO USE: to get contacts, company names or check that a site is reachable - use enrich_domains. Does no DNS lookup.',
            'COST: free; local, no network, no APIFY_TOKEN, deterministic. (enrich_domains costs $0.003 per enriched domain.)',
            'RETURNS: {domains: string[], invalid: string[], duplicates_removed: number}.',
            'PARAMETERS: inputs: each element may hold one value or a newline/comma/semicolon-separated list; pieces are trimmed and empty ones dropped. Each piece is lowercased and reduced to its hostname (scheme, path, query, port and a leading "www." removed; for a bare email the part after @ is used); other subdomains are kept, so "blog.acme.com" and "acme.com" stay separate. A piece is invalid unless the host has a dot and a 2+ letter TLD (punycode xn-- hosts accepted). domains keeps first-seen order and duplicates_removed counts repeats after normalization. This is exactly the normalization enrich_domains applies, so domains.length x $0.003 is the maximum cost of passing the same inputs to enrich_domains. An empty array is accepted and returns empty lists.',
            'EXAMPLE: {"inputs":["https://www.Stripe.com/pricing","info@stripe.com","not a domain"]} -> {"domains":["stripe.com"],"invalid":["not a domain"],"duplicates_removed":1}',
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
        return ok({ domains: [...out], invalid, duplicates_removed: dup });
    },
);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
    console.error('fairquery-contact-enricher MCP server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
