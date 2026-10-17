/**
 * Runs fn under a wall-clock limit. At softMs the AbortSignal passed to fn is aborted, so fn can stop its
 * requests and return what it has. If fn still has not settled graceMs later (a non-abortable await), the
 * returned promise resolves with 'hard-timeout' and fn's late result is ignored by the caller.
 */
export async function runWithDeadline(
    fn: (signal: AbortSignal) => Promise<void>,
    softMs: number,
    graceMs: number,
): Promise<'ok' | 'hard-timeout'> {
    const ctrl = new AbortController();
    const soft = setTimeout(() => ctrl.abort(new Error('time limit')), softMs);
    let hardTimer: NodeJS.Timeout | undefined;
    const hard = new Promise<'hard-timeout'>((resolve) => {
        hardTimer = setTimeout(() => resolve('hard-timeout'), softMs + graceMs);
    });
    try {
        return await Promise.race([fn(ctrl.signal).then(() => 'ok' as const), hard]);
    } finally {
        clearTimeout(soft);
        clearTimeout(hardTimer);
    }
}
