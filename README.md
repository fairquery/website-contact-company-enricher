# Website Contact Details & Company Data Enricher

## What does it do?

This **contact details** enricher turns a list of **company domains** into one clean row per company: **business emails** (checked for MX, disposable domains and typos), **phone numbers** in E.164 format, **social profiles**, **company name**, description and **postal address**. It reads the homepage plus the contact, about and imprint pages it finds there.

It uses plain HTTP with no browser, **respects robots.txt** and makes one request at a time per site. You pay once per domain, however many pages it reads (up to 5 by default).

## How much does it cost?

Pay per event, no subscription. Prices per 1,000 domains:

| Event | Free plan | Starter (Bronze) | Scale (Silver) | Business (Gold) |
|---|---|---|---|---|
| `domain-enriched` (primary) | $3.00 | $2.70 | $2.40 | $2.00 |

The [Apify Free plan](https://apify.com/pricing) includes **$5 of usage every month**, no credit card needed, and this Actor's event charges come out of that $5. That covers about **1,660 domains a month** ($5 ÷ ($3.00/1,000)), plus a start fee of $0.05 per 1,000 runs. Unreachable, blocked or invalid domains are never charged.

**Example (Free-plan prices):** 1,000 domains where 120 are unreachable or blocked: 880 × ($3.00/1,000) = **$2.64**.

Paid Apify plans get the Store discount automatically: Starter = Bronze, Scale = Silver, Business = Gold. Set a maximum cost per run in the run options and the Actor stops cleanly at that limit.

## How to use it

1. Paste **Domains** (for example `stripe.com`, `basecamp.com`), one per line.
2. Choose pages per domain, the **email scope** (role addresses by default) and whether to validate emails.
3. Click **Start** and export one row per company as CSV, Excel or JSON, or feed it from a Google Maps or lead-list export.

**Example input**

```json
{
  "domains": [
    "apify.com",
    "stripe.com",
    "basecamp.com"
  ],
  "maxPagesPerDomain": 5,
  "emailScope": "role"
}
```

**Example output** (one row from a real run on 2026-10-17, shortened to the main fields):

```json
{
  "domain": "apify.com",
  "company_name": "Apify Technologies s.r.o.",
  "emails": [
    {
      "email": "hello@apify.com",
      "source_url": "https://apify.com/contact",
      "is_role_account": true,
      "verdict": "valid",
      "has_mx": true
    }
  ],
  "primary_email": "hello@apify.com",
  "phones": [],
  "social_links": {
    "github": [
      "https://github.com/apify"
    ],
    "linkedin": [
      "https://linkedin.com/company/apify"
    ],
    "twitter": [
      "https://x.com/apify"
    ]
  },
  "address": "Na Příkopě 959/27, 11000, Prague, CZ",
  "pages_crawled": [
    "https://apify.com/",
    "https://apify.com/contact",
    "https://apify.com/contact-sales",
    "https://apify.com/about"
  ],
  "robots_txt": "ok",
  "email_scope": "role"
}
```

## FAQ

### How do I find contact emails from a list of company websites?

Paste the domains into **Domains** and run. Each row lists the public business emails, phones and social links the company publishes on its own site.

### Does it find personal emails of employees?

By default it returns role addresses (info@, sales@, support@). It only reads what the company publishes on its own website and does not guess or generate addresses.

### How many domains can I enrich for free?

About 1,660 per month on Apify's Free plan, which includes $5 of usage.

### Is it GDPR-compliant to use this data?

That depends on how you use it. Business contact data can still be personal data, so you need a lawful basis and must follow anti-spam law. This is not legal advice.

## Limits

Only reads information companies publish on their own sites; sites that block automated access are skipped. DNS checks can't prove a mailbox exists.

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
| `domainTimeoutSecs` | int | `40` | Hard limit per domain (all pages + DNS). At the limit you get the data collected so far (`partial: true`), or an uncharged `DOMAIN_TIMEOUT` error row if the homepage never loaded |
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
  "social_links": { "linkedin": ["https://linkedin.com/company/apify"], "twitter": ["https://x.com/apify"] },
  "address": "Na Příkopě 959/27, 11000, Prague, CZ",
  "mail_domain": { "has_mx": true, "null_mx": false, "mail_provider": "Google Workspace / Gmail", "has_spf": null, "has_dmarc": null, "dmarc_policy": null },
  "pages_crawled": ["https://apify.com/", "https://apify.com/contact"], "pages_blocked_by_robots": 0, "robots_txt": "ok", "email_scope": "role"
}
```

Error rows (`type: "error"`, never charged): `INPUT_EMPTY`, `INVALID_DOMAIN`, `MAX_DOMAINS_EXCEEDED`, `SITE_UNREACHABLE`, `BLOCKED_BY_ROBOTS`, `ENRICH_FAILED`, `DOMAIN_TIMEOUT`, `RUN_TIMEOUT_NEAR`.

**`RUN_SUMMARY`** (key-value store): pages fetched, pages blocked by robots.txt, emails found vs. excluded by scope, DNS requests, charged events.

## Pricing

| Event | Price | When |
| --- | --- | --- |
| `domain-enriched` | $3.00 per 1,000 | Each domain that returns a result row |
| `apify-actor-start` | $0.05 per 1,000 runs | Once per run, per GB of memory (Apify default event) |

Error rows (`SITE_UNREACHABLE`, `BLOCKED_BY_ROBOTS`, `INVALID_DOMAIN`, `ENRICH_FAILED`, …) are **never charged**. A domain is charged once, however many pages are crawled (up to `maxPagesPerDomain`).

**Worked example:** 1,000 domains from a Google Maps export, of which 120 are unreachable or blocked: 880 × ($3.00/1,000) = **$2.64**, plus $0.05 per 1,000 runs.

To cap spend, set a maximum cost per run in the run options; the Actor stops cleanly at the limit. `maxDomains` caps how many domains one run processes. Prices are from the Store pricing tab (October 2026).

## Memory / runtime

Default **256 MB**, no browser, no proxy. With the default politeness settings a domain takes about 3–8 s (homepage + 4 pages, 1 s apart), and 5 domains run in parallel, so 100 domains finish in roughly 1–3 minutes. Sites that block datacenter IPs or need JavaScript to render contact details will return fewer fields. Memory is capped at 512 MB (more does not help: the Actor is network-bound). Each domain has a hard 40 s time limit (`domainTimeoutSecs`), so one slow or tarpitting site can't hang the run, and every finished domain is saved and charged immediately. The default run timeout is 15 minutes (about 500–1,000 domains); shortly before the timeout the Actor stops starting new domains and adds an uncharged `RUN_TIMEOUT_NEAR` row listing how many were skipped, so split very large lists or raise the timeout.

## MCP / Apify tools

Call from agents via [Apify MCP](https://mcp.apify.com) with Actor `fairquery/website-contact-company-enricher`:

```json
{ "actor": "fairquery/website-contact-company-enricher", "input": { "domains": ["acme.com"] } }
```

## Works well after

- [Google Maps Scraper](https://apify.com/compass/crawler-google-places): pass the `website` column into `domains` to add a generic inbox, phone, LinkedIn page and legal name to each business.
- [Google Search Results Scraper](https://apify.com/apify/google-search-scraper) or any company list: domains, URLs and email addresses are all accepted and normalised.
- Next steps: re-check the emails with the [Email Validator](https://apify.com/fairquery/email-validator-mx-disposable) just before sending, and screen company names with the [Sanctions & Watchlist Screener](https://apify.com/fairquery/sanctions-watchlist-screener) when you onboard suppliers or customers.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Run is rejected because `domains` is required | The input had no domains. The three sample domains in the Console form are prefill only and are not sent with API calls. |
| `BLOCKED_BY_ROBOTS` or few pages crawled | The site's robots.txt disallows `FairqueryBot` for those paths, and the Actor honours it. These rows are free. |
| `SITE_UNREACHABLE` / no emails on a JavaScript-heavy site | The site blocks datacenter IPs or renders contact details with JavaScript. The Actor uses plain HTTP with no proxy or browser, so such sites return fewer fields. |
| Named people's emails missing | By default `emailScope` is `role` (info@, sales@ …). Use `business` to include named addresses on the company's own domain, but only if you have a lawful basis to process them. |
| Run slower than expected | Politeness settings: `requestDelayMs` (default 1,000 ms between requests to one site) and `domainConcurrency` (default 5). Raise concurrency rather than lowering the delay. |

## FAQ

**Where does the data come from?**

Only from pages the company publishes on its own domain: homepage, contact, about, imprint and team pages, plus JSON-LD structured data. No third-party databases.

**Does it return personal emails or LinkedIn profiles of people?**

By default it returns role and generic mailboxes only, and personal LinkedIn profiles (`/in/…`) are never returned.

**Are emails verified?**

They are checked for syntax, MX/null-MX, disposable domains and typos (the same code as the Fairquery Email Validator). There is no SMTP probing, so a mailbox is never confirmed.

**How much does it cost?**

$3.00 per 1,000 enriched domains, plus a start fee of $0.05 per 1,000 runs. Unreachable, blocked and invalid domains are free.

**How do I limit spend?**

Set a maximum cost per run in the run options and/or lower `maxDomains`.

**Is this GDPR-compliant?**

The Actor only reads what businesses publish, but business contact data can still be personal data. You need a lawful basis, must honour opt-outs and must follow anti-spam law. See the disclaimer.

## Fairquery family

Other Fairquery tools on the Apify Store. Each one returns structured rows with machine-readable error codes, and error rows are never charged:

- [Email Validator for Agents (MX, Disposable, Typo)](https://apify.com/fairquery/email-validator-mx-disposable): syntax, MX, disposable, role and typo checks without sending mail; $0.79 per 1,000 emails
- [Website Tech, SEO & llms.txt Check for Agents](https://apify.com/fairquery/website-tech-seo-ai-readiness): tech stack, SEO score, AI-crawler rules and llms.txt per site; $1.50 per 1,000 sites
- [Sanctions & Watchlist Screener (OFAC, EU, UK, UN)](https://apify.com/fairquery/sanctions-watchlist-screener): fuzzy name screening against official sanctions lists; $3 per 1,000 names + $7.00 per 1,000 runs
- [LLM Data Guard: PII & Secret Redactor](https://apify.com/fairquery/llm-data-guard-pii-secrets): redact PII and secrets before text reaches an LLM; $1.50 per 1,000 documents + $0.20 per 1,000 findings
- [Dependency Vulnerability Check for Agents](https://apify.com/fairquery/osv-dependency-vulnerability-check): packages and lockfiles against OSV.dev; $0.50 per 1,000 packages + $1.50 per 1,000 vulnerabilities
- [EDGAR Company Facts & Filings for Agents](https://apify.com/fairquery/edgar-company-facts-filings): SEC filings and XBRL facts by ticker, CIK or name; $1.50 per 1,000 companies on the free plan; lower on paid Apify plans
- [Company Jobs Feed: Greenhouse, Lever & Ashby](https://apify.com/fairquery/company-jobs-feed): live jobs from employers' own ATS boards with age and repost signals; $0.99 per 1,000 jobs + $0.50 per 1,000 boards
- [Competitor Change Tracker: Pricing, Terms, Careers & Changelog](https://apify.com/fairquery/competitor-change-tracker): watch competitors' public pricing, terms, careers and changelog pages for real changes with plain-English summaries and webhook alerts; $0.30 per 1,000 pages + $4.90 per 1,000 changes
- [AI Exposure Scanner: Public Secrets, Files & AI-Crawler Policy](https://apify.com/fairquery/ai-exposure-scanner): passive, scored scan of your own domains and public GitHub repos for leaked secrets (masked), exposed files, AI-crawler policy, security headers and SPF/DMARC; $39.00 per 1,000 domains + $3.90 per 1,000 repos + $1.90 per 1,000 findings

All Fairquery Actors: https://apify.com/fairquery

## Data handling, security and support

- **Data retention:** Each run keeps only its own storages in your Apify account (`INPUT`, the results dataset and a counts-only `RUN_SUMMARY`), under your Apify plan's retention. It fetches public pages of the domains you give and looks up MX records through Cloudflare DNS-over-HTTPS. You can delete run storages and named stores at any time in Apify Console or through the API. Fairquery's code sends nothing to Fairquery.
- **Security reports:** email info@getfairquery.com.
- **Support:** the Issues tab on this page or info@getfairquery.com. We aim to reply within 3 business days (a target, not an SLA).

## Disclaimer

Returns only information that companies publish on their own websites. You are responsible for how you use it: business contact data can still be personal data under GDPR/UK GDPR, so have a lawful basis, honour opt-outs, and follow anti-spam law (CAN-SPAM, ePrivacy/PECR) when you contact anyone. DNS checks cannot prove a mailbox exists.

## Links

- Apify Store: https://apify.com/fairquery/website-contact-company-enricher
- Contact: info@getfairquery.com
- License: MIT
