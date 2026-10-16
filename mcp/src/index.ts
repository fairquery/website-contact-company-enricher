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

const server = new McpServer({ name: 'fairquery-contact-enricher', version: '1.0.1' });

server.registerTool(
    'enrich_domains',
    {
        title: 'Enrich domains with public business contacts',
        description: [
            'WHAT: For each company domain, crawl the homepage plus up to N contact/about/imprint pages (plain HTTP, robots.txt respected, polite per-site delay) and return one row with company_name, description, business/role emails (MX, disposable and typo validated), phones (E.164), social profiles (LinkedIn company, X, Facebook, Instagram, YouTube, GitHub...), postal address and mail-domain info.',
            'WHEN TO USE: enriching a lead/CRM list of company websites with public contact data; finding the official contact email or address of a business.',
            'WHEN NOT TO USE: to clean/dedupe a messy list first or preview what will be billed, call normalize_domains (free). Not for finding personal emails of individuals, LinkedIn people search, or JavaScript-only sites that need a browser.',
            'COST: paid. Runs Apify Actor fairquery/website-contact-company-enricher with your APIFY_TOKEN; pay-per-event "domain-enriched", once per domain that returns a result row. Unreachable, blocked or invalid domains are free. ~2-10 s per domain.',
            'RETURNS: {count, items}. type="domain" row per domain: input, domain, final_url, company_name, description, emails[], primary_email, phones[] (E.164), social_links, address, addresses, mail_domain (MX/provider, SPF/DMARC if requested), pages_crawled, pages_blocked_by_robots, email_scope, enriched_at; or type="error" rows (code, message, retryable).',
            'EXAMPLE: {"domains":["stripe.com","https://basecamp.com/about"],"maxPagesPerDomain":3} -> 2 domain rows.',
        ].join('\n'),
        inputSchema: {
            domains: z
                .array(z.string().min(1))
                .min(1)
                .describe('Required. Domains, website URLs or email addresses (the domain part is used); comma/semicolon lists are split. Example: ["apify.com","https://stripe.com","info@basecamp.com"].'),
            maxPagesPerDomain: z
                .number()
                .int()
                .min(1)
                .max(15)
                .optional()
                .describe('Pages fetched per domain, 1-15 (default 5): homepage plus the best contact/about/imprint pages linked from it.'),
            emailScope: z
                .enum(['role', 'business', 'all'])
                .optional()
                .describe('"role" (default, GDPR-friendly) = generic mailboxes only (info@, sales@, support@); "business" = also named addresses on the company\'s own domain; "all" = every address published on the pages.'),
            validateEmails: z
                .boolean()
                .optional()
                .describe('Default true. DNS-over-HTTPS MX lookup plus disposable and typo checks on found emails (no SMTP probing).'),
            checkSpfDmarc: z
                .boolean()
                .optional()
                .describe('Default false. Add SPF/DMARC presence and DMARC policy for the company mail domain.'),
            defaultPhoneCountry: z
                .string()
                .length(2)
                .optional()
                .describe('ISO 3166-1 alpha-2 code, e.g. "US", "DE". When set, national-format numbers in page text are also parsed; otherwise only tel: links, JSON-LD and +international numbers. No default.'),
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
            'COST: free; local, no network, no APIFY_TOKEN, deterministic.',
            'RETURNS: {domains: string[], invalid: string[], duplicates_removed: number}.',
            'EXAMPLE: {"inputs":["https://www.Stripe.com/pricing","info@stripe.com","not a domain"]} -> {"domains":["stripe.com"],"invalid":["not a domain"],"duplicates_removed":1}',
        ].join('\n'),
        inputSchema: {
            inputs: z
                .array(z.string())
                .describe('Required. URLs, domains or email addresses; each entry may also be a newline/comma/semicolon-separated list. Example: ["https://www.acme.com/contact","sales@acme.com"].'),
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
