// Central configuration. Everything comes from environment variables so that
// secrets stay in .env (gitignored) and never in code.
import dotenv from "dotenv";
dotenv.config({ quiet: true });
import path from "node:path";

const env = (key: string, fallback = ""): string => (process.env[key] ?? fallback).trim();
const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export type DataMode = "zetaris" | "local";
export type AiMode = "nightshift" | "mock";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export const config = {
  port: num("PORT", 4180),
  // "zetaris" sends every federated query through Zetaris. "local" uses an
  // embedded DuckDB stand-in with the same table names, for offline dev/tests.
  dataMode: (env("DATA_MODE", "local") as DataMode),
  aiMode: (env("AI_MODE", "mock") as AiMode),
  dataDir: path.resolve(ROOT, env("DATA_DIR", ".data")),

  zetaris: {
    // UI proxy origin (port 3000 on a local install), as used by the official
    // getting-started helpers: POST /api/proxy/sql-editor/sqls/run-query
    baseUrl: env("ZETARIS_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
    orgId: env("ZETARIS_ORG_ID"),
    apiKey: env("ZETARIS_API_KEY"),
    username: env("ZETARIS_USERNAME"),
    password: env("ZETARIS_PASSWORD"),
    engineId: env("ZETARIS_ENGINE_ID"),
    queryLimit: num("ZETARIS_QUERY_LIMIT", 5000),
    timeoutMs: num("ZETARIS_TIMEOUT_MS", 120_000),
    // How Zetaris (inside Docker) reaches services on your machine.
    sourceHost: env("ZETARIS_SOURCE_HOST", "host.docker.internal"),
  },

  // Where Zetaris (running in Docker, or on AWS) finds the three source systems.
  // Defaults suit a local Zetaris install on Docker Desktop with `docker compose up`.
  sources: {
    erpJdbcUrl: env("ERP_JDBC_URL", "jdbc:postgresql://host.docker.internal:5433/rs_erp"),
    erpUser: env("ERP_DB_USER", env("PGUSER", "rs")),
    erpPassword: env("ERP_DB_PASSWORD", env("PGPASSWORD", "rs_local_dev")),
    refS3Bucket: env("REF_S3_BUCKET", env("MINIO_BUCKET", "rs-reference")),
    refS3Endpoint: env("REF_S3_ENDPOINT", "http://host.docker.internal:9000"),
    refS3AccessKey: env("REF_S3_ACCESS_KEY", env("MINIO_ACCESS_KEY", "rsminio")),
    refS3SecretKey: env("REF_S3_SECRET_KEY", env("MINIO_SECRET_KEY", "rsminio-local-dev")),
    portalUrl: env("PORTAL_URL", "http://host.docker.internal:8099/api/declarations.json"),
  },

  names: {
    erp: env("RS_ERP_SOURCE", "rs_erp"),
    ref: env("RS_REF_DATABASE", "rs_ref"),
    portal: env("RS_PORTAL_DATABASE", "rs_portal"),
    views: env("RS_VIEWS_CONTAINER", "rs_views"),
  },

  postgres: {
    host: env("PGHOST", "localhost"),
    port: num("PGPORT", 5433),
    database: env("PGDATABASE", "rs_erp"),
    user: env("PGUSER", "rs"),
    password: env("PGPASSWORD", "rs_local_dev"),
  },

  minio: {
    endpoint: env("MINIO_ENDPOINT", "localhost"),
    port: num("MINIO_PORT", 9000),
    useSSL: env("MINIO_USE_SSL", "false") === "true",
    accessKey: env("MINIO_ACCESS_KEY", "rsminio"),
    secretKey: env("MINIO_SECRET_KEY", "rsminio-local-dev"),
    bucket: env("MINIO_BUCKET", "rs-reference"),
  },

  nightshift: {
    // Meterless Runtime provider contract 0.90.0 (docs/agent-ready/add-meterless-provider.md)
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    token: env("METERLESS_RUNTIME_TOKEN"),
    tokenFile: env("METERLESS_TOKEN_FILE"),
    appId: "slavery-compliance-agent",
    timeoutMs: num("METERLESS_TIMEOUT_MS", 180_000),
    models: {
      planner: env("MODEL_PLANNER", "meterless/auto"),
      parser: env("MODEL_PARSER", "meterless/fast"),
      classifier: env("MODEL_CLASSIFIER", "meterless/fast"),
      drafter: env("MODEL_DRAFTER", "meterless/auto"),
      // Point this at your NVIDIA Nemotron route once NVIDIA is connected in
      // Nightshift's Providers tab (see `npm run nightshift:check`).
      evaluator: env("MODEL_EVALUATOR", "meterless/deep"),
    },
    concurrency: num("LLM_CONCURRENCY", 4),
  },

  agent: {
    maxIterations: num("MAX_ITERATIONS", 3),
    // tiered: the model plans, but tier 2 checks wait for the evaluator to ask for them
    // free:   the model may choose any tool at any time
    // policy: no model for planning
    plannerMode: env("PLANNER_MODE", "tiered") as "tiered" | "free" | "policy",
    worldNamespace: env("WORLD_NAMESPACE", "harbourside"),
  },
  // The assessment covers the 12 months up to this date. Defaults to today.
  assessmentDate: env("ASSESSMENT_DATE") || undefined,
};

export type Config = typeof config;
