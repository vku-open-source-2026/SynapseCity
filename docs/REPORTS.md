# City report generation and the Tier-2 jobs contract

SynapseCity report generation is **synchronous by design**. This note records
the decision and the conditions under which it must change.

## What City does today

`POST /v1/reports` and `POST /v1/reports/:id/generate` load City records
(`city-assets`, `city-incidents`, `city-maintenance`), aggregate them in memory,
serialize CSV/JSON bytes, and store the artifact on the `city-reports` record.
`GET /v1/reports/:id/download` streams those bytes. The work is bounded by the
Tier-1 record scan limit (`500` records per page, `5000` records per request in
the City adapter), so the request completes in the same HTTP call and reports a
real `content_sha256`, `row_count` and `completed_at`.

## Why not the Tier-2 runner yet

The Tier-2 `jobs` capability exposes the `report.generate` runner kind
(`docs/RUNNER.md` in SynapseDX). A runner job requires a **separate Tier-3
runner process** that leases work, renders the artifact and reports completion.
City has no such worker deployment, and the current report volume does not
justify one:

- aggregation is a small number of record pages;
- the largest supported artifact is CSV/JSON text, not PDF rendering;
- the API contract already returns a completed artifact, and callers rely on it.

Creating a job and returning an artifact that is not produced until a worker
runs would be a fake asynchronous success. City therefore reports
`capabilities.jobs.status = "not_used"` in `/v1/city` and `/health` instead of
pretending to use the runner.

## When to adopt the runner

Move report generation to a runner job (keep a synchronous fallback behind a
feature flag) when any of these becomes true:

1. a report can no longer be produced within the HTTP request budget (for
   example PDF rendering or >5,000 source rows);
2. reports must be scheduled (nightly/periodic) rather than operator-triggered;
3. the artifact must be uploaded through `files` instead of stored inline.

The implementation would then:

1. create a `report.generate` job with `executor: "runner"` and a payload
   `{reportType, format, filters, fileId}`;
2. lease it from a City runner process (CronJob/systemd timer);
3. build the same `generateReport()` artifact, upload it through the files
   capability, and mark the `city-reports` record completed;
4. expose `nextRunAt`/`lastStatus` from Tier-2 at `GET /v1/capabilities/jobs/:id`
   and a City read model at `GET /v1/reports/:id`.

The City report renderer (`apps/city-service/src/reports.ts`) is deliberately
pure so it can be reused unchanged by a future runner.
