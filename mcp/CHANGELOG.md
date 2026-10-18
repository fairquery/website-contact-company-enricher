# Changelog (MCP server)

## 1.1.0 - unreleased (preview)
- enrich_domains: new optional `waitForFinish` (default true). false starts the Actor run and returns at once with `run` (run_id, status, dataset_id, console_url); same price.
- New free tool `get_enrichment_results`: status and paged rows of such a run (GET-only Apify API reads; rejects runs of other Actors with RUN_NOT_FOR_THIS_ACTOR).
- normalize_domains: new output fields `billable_count` (max 1000 per run) and `estimated_max_cost_usd` (billable_count x $0.003 + $0.00005 start fee).
- Smoke test covers the new fields and tool; `--call` also runs the async start + poll path. CI runs the offline MCP smoke test.

## 1.0.3 - 2026-10-18
- Tool text only (Glama conciseness pass): enrich_domains RETURNS shortened to what `outputSchema` does not say; prices appear only under COST.
- normalize_domains: COST and RETURNS no longer repeat each other; RETURNS says the domains list is exactly what enrich_domains would bill.
- No tool names, input or output schemas, limits, behavior or prices changed.
