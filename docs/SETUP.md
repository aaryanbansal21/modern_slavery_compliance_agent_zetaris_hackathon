# Setup

Two ways to run Reasonable Steps:

| Mode | What runs | Use it for |
|---|---|---|
| Offline | Embedded DuckDB copy of the tables, deterministic agent policies | Development, tests, a demo without Zetaris or models |
| Full | Zetaris federating PostgreSQL, MinIO and the REST portal; models through Meterless Nightshift with NVIDIA | The demo video and the submission |

## Prerequisites

- Node.js 20 or later (`node --version`)
- Docker Desktop, with at least 8 GB of memory available to Docker for Zetaris (Settings, Resources)
- A Zetaris Cloud account for the platform download
- Meterless Nightshift (the free Mac M1+ edition gives a local endpoint for apps), and an NVIDIA API key from build.nvidia.com

## 1. Offline mode

```bash
npm install
cp .env.example .env
npm test
npm run demo
npm start             # http://localhost:4180
```

## 2. Install Zetaris locally

Follow the official guide: [Install Zetaris locally](https://github.com/zetaris/getting-started/blob/main/docs/install/updated_zetaris_installation_guide.md). In short:

1. Sign in at [Zetaris Cloud](https://www.zetaris.com/cloud), open the Run locally page and download `zetaris-platform.zip` with its `.env`.
2. Unzip outside Downloads, then `docker login zetarishackathon.azurecr.io` with the credentials shown on that page.
3. Run `./preflight.sh`, edit the platform `.env` (admin email and password, `ZSPARK_DRIVER_MEM=2g`, `ZSPARK_MASTER_URL=local[2]`), then `docker compose pull && docker compose up -d`.
4. Run `./verify.sh` until all checks pass, then open http://localhost:3000 and run `SELECT 1 AS one;` in the SQL Editor.

The first download and startup take 30 to 45 minutes. If your laptop cannot spare 8 GB for Docker, use the managed AWS cluster instead and see "Zetaris on AWS" below.

## 3. Start the source systems

From this folder:

```bash
docker compose up -d          # rs-postgres (ERP), rs-minio (object storage), rs-portal (REST)
npm run fetch:data            # DFAT Consolidated List and the full DOL List of Goods
npm run seed:postgres         # ERP tables into PostgreSQL
npm run upload:minio          # reference lists into MinIO, one folder per table
curl -s localhost:8099/api/declarations.json | head -c 200    # the portal answers
```

If `npm run fetch:data` cannot download a file, download it in a browser and pass the path. The script prints the exact command.

## 4. Connect this app to Zetaris

In the Zetaris UI:

1. Management, Organisation: copy the numeric ID into `ZETARIS_ORG_ID`.
2. Management, API Tokens: create a token and put it in `ZETARIS_API_KEY`. Or set `ZETARIS_USERNAME` and `ZETARIS_PASSWORD` to the admin account.

`ZETARIS_BASE_URL` is the UI origin (`http://localhost:3000` locally), not the raw API on port 8888. Then:

```bash
npm run zetaris:setup -- --dry-run    # print the Lightning SQL it will run
npm run zetaris:setup                 # register the ERP, the reference lists and the portal
npm run zetaris:verify                # every table and every agent query, compared with the offline copy
```

The setup registers:

| Zetaris object | Kind | Source |
|---|---|---|
| `rs_erp.suppliers`, `rs_erp.purchase_lines`, `rs_erp.company_profile` | JDBC datasource tables | PostgreSQL in `rs-postgres` |
| `rs_ref.dfat_sanctions`, `rs_ref.dol_goods`, `rs_ref.good_keywords`, `rs_ref.sector_risk` | Lightning filestore tables (CSV) | `s3a://rs-reference/<table>/` in `rs-minio` |
| `rs_portal.declarations_raw` | Lightning REST table | `rs-portal` JSON endpoint |
| `rs_views.declarations` | SchemaStore view | flattens the REST JSON with `LATERAL VIEW explode(data)` |

When `zetaris:verify` is clean, set `DATA_MODE=zetaris` in `.env`.

## 5. Connect Meterless Nightshift and NVIDIA

1. Install Nightshift and start it. The app's provider endpoint is `http://127.0.0.1:8088/v1` by default.
2. In Nightshift's Providers tab, add your NVIDIA API key, so NVIDIA models (Nemotron) become available as routes.
3. Copy the runtime token from `<stateDir>/proxy-token` into `METERLESS_RUNTIME_TOKEN` (or set `METERLESS_TOKEN_FILE` to that file).
4. Run:

```bash
npm run nightshift:check -- --detect
```

It lists the routes Nightshift offers, marks the NVIDIA ones, and sends a short test request for each agent role. Set `MODEL_EVALUATOR` to the Nemotron route it shows. Then set `AI_MODE=nightshift` and start the app.

Model replies are cached in `.data/llm-cache` so a repeat run (for example a second take of the demo video) is fast. Set `LLM_CACHE=off` for a fully fresh run.

## 6. Run

```bash
npm start
```

Open http://localhost:4180 and press "Check suppliers and draft answers". The header shows which data layer and AI provider are live.

## Troubleshooting

**Zetaris cannot reach the source systems.** Zetaris runs inside Docker, so `localhost` inside Zetaris is Zetaris itself. The defaults use `host.docker.internal`, which Docker Desktop maps to your Mac. If registration fails with a connection error, join the source containers to the Zetaris network instead:

```bash
docker network ls                                    # find the Zetaris network, for example zetaris-platform_default
for c in rs-postgres rs-minio rs-portal; do docker network connect zetaris-platform_default $c; done
```

Then set these in `.env` and rerun `npm run zetaris:setup`:

```
ERP_JDBC_URL=jdbc:postgresql://rs-postgres:5432/rs_erp
REF_S3_ENDPOINT=http://rs-minio:9000
PORTAL_URL=http://rs-portal/api/declarations.json
```

**A statement says the object already exists.** The setup skips it. To change a definition, run `npm run zetaris:setup -- --teardown`, run the printed drops in the SQL Editor, then set up again.

**The REST table registers but the view fails.** Check the response shape with `SELECT * FROM rs_portal.declarations_raw` in the SQL Editor. The view expects a top-level `data` array. Rerun just the view with `npm run zetaris:setup -- --only=portal-view`.

**HTTP 404 or an HTML page from Zetaris.** `ZETARIS_BASE_URL` must be the UI origin without a path.

**Nightshift shows unauthorized.** The token is wrong or missing. Nightshift rejects the placeholder `rt-local`.

**Zetaris on AWS.** A cluster in AWS cannot see your laptop. Put the sources where it can reach them. Create the S3 bucket yourself in the S3 console, in the cluster's region (the Zetaris guide recommends `us-west-1`), because the upload script would otherwise create it in `us-east-1`. The portal URL works once the repo is public and pushed.

```
REF_S3_ENDPOINT=s3.us-west-1.amazonaws.com     # with REF_S3_BUCKET, REF_S3_ACCESS_KEY, REF_S3_SECRET_KEY
ERP_JDBC_URL=jdbc:postgresql://<your Neon or RDS host>/<database>?sslmode=require
PORTAL_URL=https://raw.githubusercontent.com/<you>/<repo>/main/data/demo/declarations.json
```

Seed the hosted PostgreSQL with `npm run seed:postgres` (set `PGHOST`, `PGPORT=5432`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE=require`), and upload the reference files with `npm run upload:minio` (set `MINIO_ENDPOINT=s3.amazonaws.com`, `MINIO_PORT=443`, `MINIO_USE_SSL=true`, `MINIO_BUCKET` and your AWS keys).
