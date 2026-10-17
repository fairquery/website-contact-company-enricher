import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchPage } from '../src/crawl.js';
import { runWithDeadline } from '../src/deadline.js';

let server: Server;
let base = '';
beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.url === '/drip') {
            // tarpit: headers at once, then one byte every 200 ms forever
            res.writeHead(200, { 'content-type': 'text/html' });
            const t = setInterval(() => res.write('a'), 200);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (req.url === '/silent') return; // never responds
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>ok</html>');
    });
    await new Promise<void>((r) => {
        server.listen(0, '127.0.0.1', () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
    server.closeAllConnections();
    server.close();
});

describe('per-request and per-domain time limits', () => {
    it('aborts a dripping body at the request timeout', async () => {
        const t0 = Date.now();
        await expect(fetchPage(`${base}/drip`, 1000)).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(3000);
    });
    it('aborts a silent server when the outer (domain) signal fires', async () => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 500);
        const t0 = Date.now();
        await expect(fetchPage(`${base}/silent`, 30_000, ctrl.signal)).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(2500);
    });
    it('normal page still works', async () => {
        expect((await fetchPage(`${base}/ok`, 5000)).html).toContain('ok');
    });
    it('soft limit lets fn finish with partial data', async () => {
        let partial = false;
        const r = await runWithDeadline(
            async (signal) => {
                await fetchPage(`${base}/silent`, 30_000, signal).catch(() => undefined);
                partial = signal.aborted;
            },
            300,
            1000,
        );
        expect(r).toBe('ok');
        expect(partial).toBe(true);
    });
    it('hard limit returns even if fn never settles', async () => {
        const t0 = Date.now();
        const r = await runWithDeadline(() => new Promise<void>(() => undefined), 200, 300);
        expect(r).toBe('hard-timeout');
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});
