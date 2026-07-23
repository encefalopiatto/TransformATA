# TransformATA — REST API contract

All routes are served by the server package on one port (`PORT` env or
`settings.httpPort`, default 4100). The built web app is served statically
from the same port with an SPA fallback (any non-`/api` GET without a file
extension returns `index.html`). Errors return `{ "error": string }` with an
appropriate 4xx/5xx status. All bodies are JSON unless stated otherwise.

Types referenced below are defined in `shared/src/types.ts`.

## Health

- `GET /api/health` → `200 { "ok": true, "version": string }`

## Ingress

- `POST /api/inbound/:endpointId`
  - Headers: `X-Api-Key` (must equal the endpoint's `apiKey`),
    `X-File-Name` (optional), any `Content-Type` — body is read as raw text
    (limit 10 MB).
  - Endpoint must be an enabled inbound `api` endpoint.
  - Returns `202 { "jobId": string }`. Auth failure: `401`. Unknown endpoint: `404`.

## Monitor (public, read-mostly)

- `GET /api/monitor/jobs?status=&funnelId=&limit=&offset=`
  → `{ "jobs": JobSummary[], "total": number }` — newest first, snapshots
  stripped, `limit` default 50 max 200.
- `GET /api/monitor/jobs/:id` → full `Job` including stage snapshots. 404 if unknown.
- `POST /api/monitor/jobs/:id/retry` → `202 { "jobId": string }` (new job,
  `source.via = "retry"`, `source.retryOf` set, re-processes the original raw
  payload). 409 if the job has no stored payload.
- `GET /api/monitor/stats` → `MonitorStats`.
- `GET /api/monitor/stream` — Server-Sent Events.
  - event: `job`, data: `JobSummary` JSON — sent on every job create/update.
  - event: `stats`, data: `MonitorStats` JSON — sent on every job create/update.
  - A `: ping` comment is sent every 25s to keep the connection alive.
  - Clients should refresh their job list on `job` events (debounced).

## Admin — transforms (mappings)

`TransformConfig` for all three kinds; `kind` ∈ `normalization | transformation | denormalization`.

- `GET /api/admin/transforms?kind=` → `TransformConfig[]` (all kinds when omitted)
- `POST /api/admin/transforms` body `{ name, kind, description?, jsonata?, graph?, sampleInput? }`
  → `201 TransformConfig` (id generated from slugified name; `jsonata`
  defaults to `"$"` — identity).
- `GET /api/admin/transforms/:id` → `TransformConfig`
- `PUT /api/admin/transforms/:id` body: full or partial `TransformConfig`
  (id/kind immutable) → updated `TransformConfig`
- `DELETE /api/admin/transforms/:id` → `204`. `409 { error }` if referenced by a funnel.

## Admin — funnels

- `GET /api/admin/funnels` → `FunnelConfig[]` (sorted by priority)
- `POST /api/admin/funnels` body: `FunnelConfig` without id → `201 FunnelConfig`
- `GET /api/admin/funnels/:id` → `FunnelConfig`
- `PUT /api/admin/funnels/:id` → updated `FunnelConfig`
- `DELETE /api/admin/funnels/:id` → `204`
- `POST /api/admin/funnels/:id/test` body `TestFunnelRequest`
  → `200 TestFunnelResponse` — runs the full pipeline in-memory (parse using
  this funnel's input format, skip routing, run mappings, serialize;
  delivery only when `deliver: true`). Never creates a job.

## Admin — endpoints

- `GET /api/admin/endpoints?direction=` → `Endpoint[]`
- `POST /api/admin/endpoints` body: `Endpoint` without id → `201 Endpoint`
- `GET /api/admin/endpoints/:id` → `Endpoint`
- `PUT /api/admin/endpoints/:id` → updated `Endpoint`
- `DELETE /api/admin/endpoints/:id` → `204`. `409` if referenced by a funnel.
- `POST /api/admin/endpoints/:id/test` body `{ "content"?: string }`
  → `200 TestEndpointResponse` — outbound endpoints only: delivers a small
  test payload (or `content`) and reports the result. For `sftp-poll`
  inbound endpoints: attempts connection + directory listing and reports
  file count.

## Admin — utilities

- `POST /api/admin/evaluate` body `TestExpressionRequest` → `200 EvalResult`
  (server-side JSONata evaluation with timeout; used as editor fallback).
- `GET /api/admin/export` → `ConfigBundle` (Content-Disposition: attachment).
- `POST /api/admin/import` body `ConfigBundle` → `{ "imported": { "endpoints": n, "funnels": n, "transforms": n } }`
  — upserts by id, never deletes.

## Conventions

- IDs: lowercase slug of the name plus a short random suffix, e.g.
  `acme-orders-x7k2`. Generated server-side on create.
- Timestamps: ISO 8601 UTC strings.
- CORS: enabled permissively (`*`) for the API in this MVP.
