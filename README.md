# Website Contact & Company Enricher

**Fairquery** Apify Actor that turns a list of **domains** into one clean row per company: **business emails** (validated for MX, disposable domains and typos), **phone numbers** (E.164), **social profiles**, **company name**, **description** and **postal address**, taken from the homepage and its contact / about / imprint pages. Plain HTTP, no browser, **robots.txt respected**, one request at a time per site.

## When to use this Actor (LLM / tool selection)

Use it when an agent or sales-ops workflow needs to:

- Add a contact email, phone and LinkedIn company page to a list of company websites (CRM enrichment, lead lists, vendor onboarding)
- Find the generic inbox (`info@`, `sales@`, `support@`, `press@`) of a company and check that its domain actually receives mail
- Get the legal company name and address from structured data or the imprint page (EU sites)
- Collect a company's official social accounts

Do **not** use it to find personal emails of individuals or to scrape people's profiles. By default it returns **role / generic mailboxes only** (`emailScope: "role"`); personal LinkedIn profiles (`/in/…`) are never returned.

## How it works

1. Normalises each input (`https://www.Acme.com/contact`, `jane@acme.com`, `acme.com` → `acme.com`) and removes duplicates.
2. Reads `robots.txt` (RFC 9309: missing = allowed, 5xx = disallowed) and honours `Disallow` rules and `Crawl-delay` for user agent `FairqueryBot`.
3. Fetches the homepage, then the best-scoring same-site pages (contact, Kontakt, contacto, about, imprint/Impressum, legal notice, team…) up to `maxPagesPerDomain`, waiting `requestDelayMs` between requests to the same site.
4. Extracts: JSON-LD `Organization`/`LocalBusiness` (name, legalName, telephone, email, address, sameAs), `mailto:` and `tel:` links, Cloudflare-protected emails, `name [at] domain [dot] com` obfuscation, `og:site_name`, `<address>` blocks, social links.
5. Validates emails with the same code as [Fairquery Email Validator](https://apify.com/fairquery/email-validator-mx-disposable): syntax, DNS-over-HTTPS MX/null-MX, disposable list, free-provider and typo checks (no SMTP probing).

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `domains` | `string[]` | (required) | Domains, URLs or emails |
| `maxPagesPerDomain` | int | `5` | 1–15, homepage included |
| `emailScope` | `role` \| `business` \| `all` | `role` | `business` adds named addresses on the company's own domain |
| `validateEmails` | bool | `true` | MX / disposable / typo |
| `checkSpfDmarc` | bool | `false` | SPF/DMARC for the company mail domain |
| `defaultPhoneCountry` | string | – | e.g. `US`; also parse national-format numbers in page text |
| `domainConcurrency` | int | `5` | Sites in parallel |
| `requestDelayMs` | int | `1000` | Delay between requests to one site |
| `requestTimeoutSecs` | int | `15` | Per request |
| `maxDomains` | int | `1000` | Safety cap |

```json
{ "domains": ["apify.com", "stripe.com", "https://basecamp.com/"], "maxPagesPerDomain": 4 }
```

## Output

```json
{
  "schema_version": "1.0.0", "type": "domain", "input": "apify.com", "domain": "apify.com", "final_url": "https://apify.com/",
  "company_name": "Apify Technologies s.r.o.",
  "description": "Cloud platform for web scraping, browser automation, AI agents, and data for AI…",
  "emails": [
    { "email": "hello@apify.com", "source_url": "https://apify.com/contact", "is_role_account": true, "on_company_domain": true,
      "is_free_provider": false, "is_disposable": false, "verdict": "valid", "reasons": ["ROLE_ACCOUNT"], "has_mx": true, "mail_provider": "Google Workspace / Gmail" }
  ],
  "primary_email": "hello@apify.com",
  "phones": [{ "e164": "+18889262289", "raw": "+1 888 926 2289", "source_url": "https://stripe.com/contact/sales", "source": "tel" }],
  "social_links": { "linkedin": ["https://linkedin.com/company/apify"], "twitter": ["https://x.com/apify"], "github": ["https://github.com/apify"] },
  "address": "Na Příkopě 959/27, 11000, Prague, CZ",
  "mail_domain": { "has_mx": true, "null_mx": false, "mail_provider": "Google Workspace / Gmail", "has_spf": null, "has_dmarc": null, "dmarc_policy": null },
  "pages_crawled": ["https://apify.com/", "https://apify.com/contact"], "pages_blocked_by_robots": 0, "robots_txt": "ok", "email_scope": "role"
}
```

Error rows (`type: "error"`, never charged): `INPUT_EMPTY`, `INVALID_DOMAIN`, `MAX_DOMAINS_EXCEEDED`, `SITE_UNREACHABLE`, `BLOCKED_BY_ROBOTS`, `ENRICH_FAILED`.

**`RUN_SUMMARY`** (key-value store): pages fetched, pages blocked by robots.txt, emails found vs. excluded by scope, DNS requests, charged events.

## Pricing

Pay per event: **`domain-enriched`**, once per domain that returns a result row. Unreachable, blocked or invalid domains are free. See the pricing tab.

## Memory / runtime

Default **256 MB**, no browser, no proxy. With the default politeness settings a domain takes about 3–8 s (homepage + 4 pages, 1 s apart), and 5 domains run in parallel, so 100 domains finish in roughly 1–3 minutes. Sites that block datacenter IPs or need JavaScript to render contact details will return fewer fields.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) with Actor `fairquery/website-contact-company-enricher`:

```json
{ "actor": "fairquery/website-contact-company-enricher", "input": { "domains": ["acme.com"] } }
```

## Local stdio MCP server

The [`mcp/`](./mcp) folder is a stdio MCP server (TypeScript, `@modelcontextprotocol/sdk`) with two tools, both with annotations and output schemas:

| Tool | What it does | Cost |
| --- | --- | --- |
| `enrich_domains` | Runs this Actor and returns the rows | Needs `APIFY_TOKEN`, billed per domain |
| `normalize_domains` | Cleans URLs/emails into unique domains, lists invalid ones | Free, local, no token |

```bash
cd mcp && npm install && npm run build
node scripts/smoke-test.mjs                          # initialize + tools/list + free tool, no token
APIFY_TOKEN=... node scripts/smoke-test.mjs --call   # real call
```

```json
{ "mcpServers": { "fairquery-contact-enricher": { "command": "node", "args": ["/path/to/website-contact-company-enricher/mcp/dist/index.js"], "env": { "APIFY_TOKEN": "<your Apify token>" } } } }
```

Docker: the root `Dockerfile` builds the MCP server image (`docker build -t fairquery-contact-enricher-mcp .`); it is also the Dockerfile for Glama. The Actor image is `.actor/Dockerfile`. `glama.json` lists `fairquery` as maintainer.

## Local development

```bash
npm install
npx apify run      # input from storage/key_value_stores/default/INPUT.json
npm test
```

## Kits & templates

Optional guides from Fairquery for wiring this Actor into agents and automations (the Actor works fine without them):

- [AI Agent Data Toolkit Quick-Start](https://fairquery.gumroad.com/l/qayngz) (PDF): MCP setup for Claude Desktop and Cursor, API calls, recipes, cost estimates.
- [n8n + Zapier Workflow Template Pack](https://fairquery.gumroad.com/l/koffbf): 10 importable n8n workflows for the four Fairquery Actors, plus Zapier setup guides.
- [Agent Prompt Pack for Research & Lead Ops](https://fairquery.gumroad.com/l/djdilu): 69 prompts for company research, lead cleaning, SEO and security reviews.
- [Agent Starter Kit: 10 copy-paste MCP + n8n recipes](https://fairquery.gumroad.com/l/idvrck) ($5): 10 copy-paste MCP + n8n recipes, with ready-made Claude/Cursor configs and 3 starter workflows.

## Disclaimer

Returns only information that companies publish on their own websites. You are responsible for how you use it: business contact data can still be personal data under GDPR/UK GDPR, so have a lawful basis, honour opt-outs, and follow anti-spam law (CAN-SPAM, ePrivacy/PECR) when you contact anyone. DNS checks cannot prove a mailbox exists.

## Links

- License: MIT
