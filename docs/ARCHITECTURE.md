# TransformATA — Architecture

TransformATA is a GUI-first data manipulation platform for non-technical
users, powered end-to-end by [JSONata](https://jsonata.org). Files enter via
API or SFTP, are routed to a *funnel* based on identifiers found in the file,
flow through normalization → canonical → transformation → denormalization
(each a stored JSONata mapping), and exit via API or SFTP in JSON, CSV, or
XML.

```
            ┌─────────────────────────  server (one Node process)  ─────────────────────────┐
 API push ──►                                                                                │
 SFTP push ─►  ingress ──► queue (SQLite) ──► pipeline worker ──► egress ──► HTTP webhook    │
 SFTP poll ─►     │                              │                    └────► SFTP upload     │
            │     │                              │                    └────► local directory │
            │     ▼                              ▼                                           │
            │  raw file                parse → route → normalize → CANONICAL (persisted)     │
            │                          → transform → denormalize → serialize                 │
            └────────────────────────────────────────────────────────────────────────────────┘
                     ▲                                        ▲
              admin panel (React)                     monitor front end (React)
              CRUD over config files                  live queue via SSE
```

## Packages (npm workspaces)

| Package | Purpose |
|---|---|
| `shared/` | Type contracts, JSONata evaluate helper, **graph → JSONata compiler** (used by server and web) |
| `server/` | Express HTTP API, embedded SFTP server (optional), SFTP poller, SQLite job queue, pipeline engine, config file store; serves the built web app |
| `web/` | React app: public monitor (`/`), admin panel (`/admin/...`), FigJam-style visual editor (React Flow) |

## Pipeline stages

Each job records a `StageRecord` per stage (status, timing, human-readable
detail, truncated data snapshot) so the monitor can show exactly what
happened to a file:

1. **received** — raw file text stored with the job.
2. **parsed** — text → JS document per the funnel-independent format
   detection (see routing) and format conventions in `shared/src/types.ts`.
3. **routed** — enabled funnels are evaluated in priority order; the first
   whose `match.expression` (JSONata, run against the parsed document)
   matches claims the job. No match ⇒ job fails at this stage.
4. **normalized** — funnel's normalization mapping (JSONata) → **canonical**
   document. The canonical is also persisted to `data/canonical/<jobId>.json`.
5. **transformed** — funnel's transformation mapping (canonical → canonical).
6. **denormalized** — funnel's denormalization mapping (canonical → output
   shape). Stages 4–6 are each optional (pass-through when unset).
7. **serialized** — output document → text in the funnel's `outputFormat`.
8. **delivered** — sent through the funnel's outbound endpoint.

Routing nuance: funnels declare their `inputFormat`. For an inbound file the
server parses the payload once per candidate format (json/csv/xml, using each
candidate funnel's `inputOptions`) and only evaluates a funnel's match
expression against the parse in that funnel's declared format. Parse failures
for one format do not abort routing — they just rule out those funnels.

## Configuration = files

Everything the admin panel manages is a JSON file, one object per file,
filename `<id>.json`. This is deliberate: configs are diffable, reviewable,
and (on ephemeral hosts like Render's free tier) can be committed to the
repo and loaded at boot. The admin panel also offers export/import of the
full `ConfigBundle`.

The live config directory defaults to `<repo>/config` and can be relocated
with **`TRANSFORMATA_CONFIG_DIR`** (e.g. onto a persistent disk:
`render.yaml` points it at `data/config` inside the mounted disk). When the
env var targets a directory other than the repo's `config/`, it is **seeded
on first boot**: the repo tree is copied in without overwriting anything,
then a `.seeded-from-repo` marker makes every later boot leave the directory
untouched — the external directory is the source of truth from then on, so
UI edits *and deletions* survive redeploys. Deleting the marker re-runs the
non-destructive copy (picks up new repo seed files; never overwrites).

```
config/
  settings.json            AppSettings
  endpoints/<id>.json      Endpoint (inbound api | sftp | sftp-poll; outbound api | sftp | directory)
  funnels/<id>.json        FunnelConfig
  normalizations/<id>.json TransformConfig (kind=normalization)
  transformations/<id>.json TransformConfig (kind=transformation)
  denormalizations/<id>.json TransformConfig (kind=denormalization)
```

The config store reads from disk on every list/get (files are small; this
gives free hot-reload) and writes through on save.

## Runtime state

```
data/
  transformata.db      SQLite job queue + history
  canonical/<job>.json persisted canonical documents
  sftp-in/...          files received by the embedded SFTP server
  outbox/...           files delivered by `directory` outbound endpoints
  host.key             auto-generated SSH host key (embedded SFTP server)
```

`data/` is gitignored and recreated at boot.

## Ingress/egress modes

| Mode | Direction | Mechanism | Works on Render free |
|---|---|---|---|
| `api` | in | `POST /api/inbound/:endpointId` with `X-Api-Key` | ✅ |
| `sftp` | in | embedded SFTP server (ssh2), one user per endpoint | ❌ (needs raw TCP port) |
| `sftp-poll` | in | app polls a remote SFTP dir, ingests new files | ✅ |
| `api` | out | HTTP POST/PUT with configurable headers | ✅ |
| `sftp` | out | upload via ssh2-sftp-client | ✅ |
| `directory` | out | write to local dir (testing/self-hosted) | ✅ (ephemeral) |

The embedded SFTP server is enabled via `SFTP_SERVER_ENABLED=true` (or
`settings.sftpServerEnabled`) — default off.

## Queue

SQLite (Node's built-in `node:sqlite`, no native module to compile — this is
why the project requires Node >= 22.13), no external broker: jobs table holds metadata,
stage records, raw payload, and output info. An in-process worker pool
(`workerConcurrency`) claims queued jobs and runs the pipeline. Every job
state change is broadcast on an in-process event bus, streamed to the
monitor UI over SSE (`GET /api/monitor/stream`). Failed jobs can be retried
from the monitor (a new job re-runs the original raw payload).

## Visual editor

Mappings can be authored two ways, stored on the same `TransformConfig`:

- **Visual mode** — a FigJam-like canvas (React Flow): drag nodes from a
  palette, wire them with arrows, edit node properties in a side panel. The
  graph is compiled to JSONata by `shared/src/graph/compile.ts` (node emit
  rules: `docs/GRAPH_NODES.md`). Both `graph` and compiled `jsonata` are
  saved; the runtime only ever executes `jsonata`.
- **Code mode** — hand-written JSONata for power users. Switching a graph-
  backed mapping to code mode detaches the graph (with confirmation).

Live preview: the editor evaluates the current expression against the
mapping's `sampleInput` in the browser (jsonata runs client-side) on every
change.

## Security model (MVP)

- Inbound API endpoints authenticate with per-endpoint API keys.
- Admin + monitor APIs are unauthenticated in this MVP — front the service
  with access restrictions if exposed publicly, or add auth before real use.
- JSONata evaluation runs in an **isolated worker thread** (`server/src/
  jsonata-worker.ts`) that is hard-terminated after `evaluateTimeoutMs`. A
  cooperative in-process timeout cannot interrupt a synchronous/CPU-bound
  expression — the single event loop would stay blocked until it returned,
  a denial-of-service vector on the unauthenticated admin + pipeline surfaces.
  The worker isolates the evaluation so `worker.terminate()` reclaims a runaway
  while the main event loop stays responsive. All server-side evaluation
  (routing match, normalize/transform/denormalize, `POST /api/admin/evaluate`,
  funnel test) is funneled through `jsonata-runner.ts` → the worker. The cost
  is ~tens of ms per evaluation, which is acceptable for this workload.
- Outbound `directory` endpoints are constrained to the project root: an
  absolute or `../..` path is rejected on save and at delivery time, unless
  `TRANSFORMATA_ALLOW_ABSOLUTE_OUTBOX=true` (opt-in for self-hosted use).

## Deploy (Render)

`render.yaml` defines a single free web service: `npm install && npm run
build`, `npm start`, health check `/api/health`, HTTP port from `PORT`.
Free-tier caveats are documented in the README.
