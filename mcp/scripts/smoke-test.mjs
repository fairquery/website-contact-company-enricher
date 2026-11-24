/**
 * Smoke test: initialize + tools/list + free helper without token; main tool must return APIFY_TOKEN_MISSING.
 * Optional --call runs the main tool with APIFY_TOKEN (value never printed).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const MAIN_ARGS = { domains: ['apify.com'] };

async function withClient(env, fn) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverJs], env, stderr: 'pipe' });
    const client = new Client({ name: 'fairquery-smoke', version: '1.0.0' });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

const env = { ...process.env };
delete env.APIFY_TOKEN;
await withClient(env, async (client) => {
    const { tools } = await client.listTools();
    console.log('OK tools/list:', tools.map((t) => `${t.name}${t.outputSchema ? ' (outputSchema)' : ''}${t.annotations ? ' (annotations)' : ''}`).join(', '));
    for (const n of ['enrich_domains', 'normalize_domains', 'get_enrichment_results']) if (!tools.some((t) => t.name === n)) throw new Error('missing tool ' + n);
    const h = await client.callTool({ name: 'normalize_domains', arguments: { inputs: ['https://www.Apify.com/contact', 'jane@stripe.com'] } });
    if (h.isError || !h.structuredContent) throw new Error('helper failed: ' + JSON.stringify(h).slice(0, 300));
    const sc = h.structuredContent;
    if (sc.billable_count !== 2 || sc.estimated_max_cost_usd !== 0.00605) throw new Error('cost preview wrong: ' + JSON.stringify(sc));
    const many = await client.callTool({ name: 'normalize_domains', arguments: { inputs: Array.from({ length: 1200 }, (_, i) => `d${i}.com`) } });
    if (many.structuredContent.billable_count !== 1000 || many.structuredContent.estimated_max_cost_usd !== 3.00005) throw new Error('cap wrong: ' + JSON.stringify(many.structuredContent).slice(-200));
    console.log('OK normalize_domains (free, no token; billable_count/estimated_max_cost_usd, 1000 cap)');
    const g = await client.callTool({ name: 'get_enrichment_results', arguments: { runId: 'abcdefghijklmnopq' } });
    if (!JSON.stringify(g).includes('APIFY_TOKEN_MISSING')) throw new Error('expected APIFY_TOKEN_MISSING from get_enrichment_results');
    const a = await client.callTool({ name: 'enrich_domains', arguments: { ...MAIN_ARGS, waitForFinish: false } });
    if (!JSON.stringify(a).includes('APIFY_TOKEN_MISSING')) throw new Error('expected APIFY_TOKEN_MISSING (async)');
    console.log('OK get_enrichment_results / async enrich_domains without token -> APIFY_TOKEN_MISSING');
    const r = await client.callTool({ name: 'enrich_domains', arguments: MAIN_ARGS });
    if (!JSON.stringify(r).includes('APIFY_TOKEN_MISSING')) throw new Error('expected APIFY_TOKEN_MISSING');
    console.log('OK enrich_domains without token -> APIFY_TOKEN_MISSING');
});

if (process.argv.includes('--call')) {
    if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN not set for --call');
    await withClient({ ...process.env }, async (client) => {
        const r = await client.callTool({ name: 'enrich_domains', arguments: MAIN_ARGS });
        if (r.isError) throw new Error('call failed: ' + JSON.stringify(r).slice(0, 500));
        console.log('OK enrich_domains call, items:', r.structuredContent?.count);
        const s1 = await client.callTool({ name: 'enrich_domains', arguments: { ...MAIN_ARGS, maxPagesPerDomain: 1, waitForFinish: false } });
        const runId = s1.structuredContent?.run?.run_id;
        if (s1.isError || !runId || s1.structuredContent.count !== 0) throw new Error('async start failed: ' + JSON.stringify(s1).slice(0, 500));
        console.log('OK enrich_domains waitForFinish=false -> run started, status', s1.structuredContent.run.status);
        let res;
        for (let i = 0; i < 30; i++) {
            res = await client.callTool({ name: 'get_enrichment_results', arguments: { runId } });
            if (res.isError) throw new Error('poll failed: ' + JSON.stringify(res).slice(0, 500));
            if (res.structuredContent.run.finished) break;
            await new Promise((r) => setTimeout(r, 5000));
        }
        const rs = res.structuredContent;
        if (rs.run.status !== 'SUCCEEDED' || rs.total < 1 || rs.items[0].type !== 'domain') throw new Error('unexpected result: ' + JSON.stringify(rs).slice(0, 500));
        console.log('OK get_enrichment_results', rs.run.status, 'rows', rs.total);
        const bad = await client.callTool({ name: 'get_enrichment_results', arguments: { runId: 'zzzzzzzzzzzzzzzzz' } });
        if (!JSON.stringify(bad).includes('RUN_NOT_FOUND')) throw new Error('expected RUN_NOT_FOUND');
        console.log('OK unknown run -> RUN_NOT_FOUND');
    });
}
