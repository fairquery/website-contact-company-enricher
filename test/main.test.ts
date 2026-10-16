import { describe, expect, it } from 'vitest';

import { isRole, parseEmail } from '../src/checks.js';
import { normalizeDomain } from '../src/crawl.js';
import {
    classifySocial,
    decodeCfEmail,
    emptyPageData,
    extractEmails,
    parsePage,
    pickCompanyName,
    pickPages,
} from '../src/extract.js';

const HTML = `<html><head><title>Home | Acme Widgets</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Widgets GmbH","telephone":"+49 30 1234567",
"address":{"@type":"PostalAddress","streetAddress":"Hauptstr. 1","postalCode":"10115","addressLocality":"Berlin","addressCountry":"DE"},
"sameAs":["https://www.linkedin.com/company/acme-widgets","https://twitter.com/acme"]}</script></head>
<body><a href="mailto:info@acme.example.org?subject=hi">Mail</a><a href="tel:+1-415-555-0132">Call</a>
<a href="/kontakt">Kontakt</a><a href="/about-us">About us</a><a href="/blog/post">Blog</a><a href="https://facebook.com/sharer.php?u=x">share</a>
<p>sales [at] acme-widgets.de</p><span class="__cf_email__" data-cfemail="543d3a323b14353739317a373b39">x</span></body></html>`;

describe('extract', () => {
    it('parses JSON-LD, mailto, tel, socials, obfuscated + Cloudflare emails', () => {
        const d = emptyPageData();
        parsePage(HTML, 'https://acme-widgets.de/', d, {});
        expect([...d.emails.keys()]).toEqual(
            expect.arrayContaining(['info@acme.example.org', 'sales@acme-widgets.de', 'info@acme.com']),
        );
        expect([...d.phones.keys()]).toEqual(expect.arrayContaining(['+49301234567', '+14155550132']));
        expect([...(d.socials.get('linkedin') ?? [])]).toEqual(['https://linkedin.com/company/acme-widgets']);
        expect(d.socials.has('facebook')).toBe(false);
        expect(d.addresses[0]).toBe('Hauptstr. 1, 10115, Berlin, DE');
        expect(pickCompanyName(d.companyNames, 'acme-widgets.de')).toBe('Acme Widgets GmbH');
        expect(pickPages(d.links, new URL('https://acme-widgets.de/'), 3)).toEqual([
            'https://acme-widgets.de/kontakt',
            'https://acme-widgets.de/about-us',
        ]);
    });
    it('helpers', () => {
        expect(decodeCfEmail('543d3a323b14353739317a373b39')).toBe('info@acme.com');
        expect(extractEmails('logo@2x.png hello@x.io')).toEqual(['hello@x.io']);
        expect(classifySocial('https://x.com/intent/tweet?x')).toBeNull();
        expect(normalizeDomain('https://www.Example.com/path')).toBe('example.com');
        expect(normalizeDomain('jane@acme.io')).toBe('acme.io');
        expect(normalizeDomain('not a domain')).toBeNull();
        expect(pickCompanyName(['__title__Pricing - Basecamp'], 'basecamp.com')).toBe('Basecamp');
        expect(isRole(parseEmail('sales@acme.com')!.local)).toBe(true);
    });
});
