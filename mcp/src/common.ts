/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared helpers for Fairquery stdio MCP servers.
 * APIFY_TOKEN is read from the environment only for tool calls and is never logged or returned.
 */
export const APIFY_BASE = 'https://api.apify.com/v2';

export type ToolResult = {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [k: string]: unknown;
};

export function ok(structured: Record<string, unknown>): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

export function fail(error: string, message: string): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }], isError: true };
}

export function getToken(): string | null {
    const t = process.env.APIFY_TOKEN?.trim();
    return t ? t : null;
}

export const TOKEN_MISSING = () =>
    fail(
        'APIFY_TOKEN_MISSING',
        'Set the APIFY_TOKEN environment variable to your Apify API token before calling this tool. Initialize, tools/list and the free helper tool work without a token.',
    );

export function compact(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
    return out;
}

/** Runs the Actor synchronously and returns its dataset items. */
export async function runActor(actorId: string, input: Record<string, unknown>, token: string, waitSecs = 280): Promise<unknown[]> {
    const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?timeout=${waitSecs}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout((waitSecs + 30) * 1000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    if (!res.ok) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor run failed (HTTP ${res.status}): ${raw.slice(0, 2000)}`);
    }
    return Array.isArray(body) ? body : [body];
}

export async function callActorTool(actorId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const token = getToken();
    if (!token) return TOKEN_MISSING();
    try {
        const items = await runActor(actorId, compact(args), token);
        return ok({ items, count: items.length });
    } catch (e) {
        return fail('APIFY_ACTOR_RUN_FAILED', e instanceof Error ? e.message : String(e));
    }
}

export const READ_ONLY_REMOTE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const READ_ONLY_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

async function apifyJson(url: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: any = text;
    try {
        body = JSON.parse(text);
    } catch {
        /* keep raw text */
    }
    return { status: res.status, body, headers: res.headers };
}

export type RunInfo = {
    run_id: string;
    status: string;
    finished: boolean;
    dataset_id: string | null;
    started_at: string | null;
    finished_at: string | null;
    console_url: string;
};

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export function runInfo(d: any): RunInfo {
    return {
        run_id: String(d.id),
        status: String(d.status),
        finished: TERMINAL.has(String(d.status)),
        dataset_id: d.defaultDatasetId ?? null,
        started_at: d.startedAt ?? null,
        finished_at: d.finishedAt ?? null,
        console_url: `https://console.apify.com/actors/runs/${d.id}`,
    };
}

/** Starts an Actor run without waiting (POST /acts/{id}/runs). */
export async function startActor(actorId: string, input: Record<string, unknown>, token: string): Promise<RunInfo> {
    const { status, body } = await apifyJson(`${APIFY_BASE}/acts/${actorId}/runs`, token, { method: 'POST', body: JSON.stringify(input) });
    if (status !== 201 && status !== 200) {
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        throw new Error(`Apify Actor start failed (HTTP ${status}): ${raw.slice(0, 2000)}`);
    }
    return runInfo(body.data);
}

export class RunLookupError extends Error {
    constructor(public code: string, message: string, public retryable: boolean) {
        super(message);
    }
}

/** Reads a run of this Actor and one page of its dataset (GET only; starts nothing). */
export async function readRun(actorId: string, runId: string, token: string, offset: number, limit: number) {
    const actor = await apifyJson(`${APIFY_BASE}/acts/${actorId}`, token);
    if (actor.status !== 200) throw new RunLookupError('APIFY_ACTOR_LOOKUP_FAILED', `GET actor -> HTTP ${actor.status}`, actor.status >= 500);
    const run = await apifyJson(`${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}`, token);
    if (run.status === 404) throw new RunLookupError('RUN_NOT_FOUND', `No run ${runId} is visible to this APIFY_TOKEN`, false);
    if (run.status === 401) throw new RunLookupError('APIFY_TOKEN_INVALID', 'Apify rejected the token (HTTP 401)', false);
    if (run.status !== 200) throw new RunLookupError('APIFY_RUN_LOOKUP_FAILED', `GET run -> HTTP ${run.status}`, run.status >= 500);
    if (run.body.data.actId !== actor.body.data.id) {
        throw new RunLookupError('RUN_NOT_FOR_THIS_ACTOR', `Run ${runId} belongs to another Actor; only runs started by enrich_domains can be read here`, false);
    }
    const info = runInfo(run.body.data);
    if (!info.dataset_id) return { info, items: [] as unknown[], total: 0 };
    const ds = await apifyJson(`${APIFY_BASE}/datasets/${info.dataset_id}/items?clean=true&offset=${offset}&limit=${limit}`, token);
    if (ds.status !== 200) throw new RunLookupError('APIFY_DATASET_READ_FAILED', `GET dataset items -> HTTP ${ds.status}`, true);
    const items: unknown[] = Array.isArray(ds.body) ? ds.body : [];
    // Dataset counters are eventually consistent right after a run ends, so never report fewer rows than were read.
    const headerTotal = Number(ds.headers.get('x-apify-pagination-total') ?? 0);
    const total = Math.max(Number.isFinite(headerTotal) ? headerTotal : 0, offset + items.length);
    return { info, items, total };
}
