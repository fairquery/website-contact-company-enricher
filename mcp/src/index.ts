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

const server = new McpServer({ name: 'fairquery-contact-enricher', version: '1.0.0' });

server.registerTool(
    'enrich_domains',
    {
        title: 'Enrich domains with public business contacts',
        description:
            'For each domain: crawl the homepage and up to N contact/about/imprint pages (robots.txt respected, polite delay) and return one row with company_name, description, role/business emails (MX, disposable and typo-validated), phones (E.164), social profiles (LinkedIn company, X, Facebook, Instagram, YouTube, GitHub…), postal address and mail-domain info. Runs Apify Actor fairquery/website-contact-company-enricher; requires APIFY_TOKEN, billed per enriched domain (errors free).',
        inputSchema: {
            domains: z.array(z.string().min(1)).min(1).describe('Domains, URLs or emails (domain is used)'),
            maxPagesPerDomain: z.number().int().min(1).max(15).optional().describe('Default 5'),
            emailScope: z.enum(['role', 'business', 'all']).optional().describe('role (default) = info@/sales@ only; business = + named addresses on the company domain; all'),
            validateEmails: z.boolean().optional().describe('MX/disposable/typo checks (default true)'),
            checkSpfDmarc: z.boolean().optional(),
            defaultPhoneCountry: z.string().length(2).optional().describe('ISO country to parse national-format numbers'),
        },
        outputSchema: {
            items: z.array(z.record(z.unknown())).describe('Dataset rows: type=domain or type=error'),
            count: z.number(),
        },
        annotations: { title: 'Enrich domains', ...READ_ONLY_REMOTE },
    },
    async (args) => callActorTool(ACTOR_ID, args),
);

server.registerTool(
    'normalize_domains',
    {
        title: 'Normalize and dedupe domains (free)',
        description: 'Free, local, no token: turns URLs, emails and messy strings into bare domains (lowercase, no www), removes duplicates and lists invalid entries. Use before enrich_domains to see exactly what will be billed.',
        inputSchema: { inputs: z.array(z.string()).describe('URLs, domains or email addresses') },
        outputSchema: {
            domains: z.array(z.string()),
            invalid: z.array(z.string()),
            duplicates_removed: z.number(),
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
