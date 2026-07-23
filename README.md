# TransformATA

**GUI-first data manipulation for non-technical users, powered end-to-end by [JSONata](https://jsonata.org).**

Files enter via API or SFTP (JSON, CSV, or XML), are routed to a *funnel*
based on identifiers found inside the file, flow through
**normalize → canonical → transform → denormalize** (each a stored JSONata
mapping), and exit via API or SFTP in JSON, CSV, or XML.

- 🗺 **Visual mapping editor** — build JSONata with a FigJam-like
  drag-nodes-and-draw-arrows canvas, with live preview against sample data.
  Power users can drop into raw JSONata code mode at any time.
- 🧭 **Funnels** — declarative routing: *"files whose `rows[0].partner` is
  `ACME` go through these mappings and out to this endpoint as XML"*.
- 📁 **Configs are files** — funnels, mappings, and endpoints live under
  `config/` as JSON, managed from the admin panel (and diffable in git).
- 📊 **Open monitor front end** — live queue of every file with a
  stage-by-stage timeline (with data snapshots) and one-click retry.

## Quick start

```bash
npm install
npm run build        # shared → server → web
npm start            # serves app + API on http://localhost:4100
```

Open <http://localhost:4100> — the monitor is the landing page, the admin
panel is under *Funnels / Mappings / Endpoints*.

Push a sample file through the demo funnels:

```bash
curl -X POST http://localhost:4100/api/inbound/inbound-demo-api \
  -H 'X-Api-Key: demo-key' -H 'Content-Type: text/csv' \
  --data-binary @samples/acme-orders.csv
```

Watch it complete on the monitor, then check `data/outbox/acme/` for the
delivered XML. `samples/globex-order.json` demonstrates the JSON→JSON funnel.

For development: `npm run dev` (server on :4100 with reload + Vite on :5173).
End-to-end check: `npm run smoke`.

## How a file flows

| Stage | What happens | Configured by |
|---|---|---|
| received | raw file stored with the job | inbound endpoint (`api`, `sftp`, `sftp-poll`) |
| parsed | text → document (JSON / CSV / XML conventions) | funnel `inputFormat` + options |
| routed | first enabled funnel whose JSONata `match.expression` matches claims the file | funnel `match` + `priority` |
| normalized | partner format → **canonical** document (persisted to `data/canonical/`) | normalization mapping |
| transformed | canonical → canonical (enrich, filter, delete, reshape) | transformation mapping |
| denormalized | canonical → outbound shape | denormalization mapping |
| serialized | document → JSON / CSV / XML text | funnel `outputFormat` + options |
| delivered | HTTP webhook, SFTP upload, or directory drop | outbound endpoint |

Every stage records status, timing, and a data snapshot — visible in the
monitor's job detail view.

## Deploying on Render (free tier)

The repo ships a [`render.yaml`](render.yaml) blueprint: create a new
**Blueprint** on [Render](https://render.com), point it at this repository,
and it deploys a single free web service (build `npm install && npm run
build`, start `npm start`, health check `/api/health`).

Free-tier constraints and how TransformATA handles them:

- **Ephemeral filesystem** — job history (SQLite) and admin-panel config
  edits reset on redeploy/restart. Configs committed under `config/` are
  loaded at boot; after editing configs in the UI use **Settings → Export**
  and commit the bundle back to the repo (or re-import it).
- **HTTP only** — the embedded SFTP *server* can't run on Render (no raw
  TCP). Use `sftp-poll` inbound endpoints instead: the app connects out to
  any remote SFTP server and ingests new files on an interval. Outbound
  SFTP works normally. Self-hosted deployments can enable the embedded SFTP
  server with `SFTP_SERVER_ENABLED=true` (port `settings.sftpPort`, default 4122).
- **Spin-down after inactivity** — the first request after idle takes ~30s
  (also delays `sftp-poll` ticks while asleep).

⚠️ The admin and monitor APIs are **unauthenticated** in this MVP. Inbound
API endpoints require per-endpoint API keys, but anyone with the app URL can
open the admin panel. Don't point it at sensitive data on a public URL —
add auth or IP restrictions first.

## Repository layout

```
shared/   type contracts + graph→JSONata compiler (docs/GRAPH_NODES.md)
server/   Express API, SFTP server/poller, SQLite queue, pipeline engine
web/      React app: monitor, admin panel, visual editor (React Flow)
config/   funnels, mappings (normalizations/transformations/denormalizations),
          endpoints, settings — one JSON file per object
samples/  demo inbound files for the two seeded funnels
docs/     ARCHITECTURE.md · API.md · GRAPH_NODES.md
```

## License

MIT — see [LICENSE](LICENSE).
