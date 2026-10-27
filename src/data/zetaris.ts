// Zetaris client. Sends SQL to a Zetaris instance through the UI proxy route
// used by the official getting-started helpers
// (github.com/zetaris/getting-started/scripts/zetaris_api.py):
//
//   POST {ZETARIS_BASE_URL}/api/proxy/sql-editor/sqls/run-query
//   headers: Authorization: Bearer <token>, X-Org-ID, X-Request-ID (uuid)
//   body:    { sql, limit, engineId? }
//
// The token is ZETARIS_API_KEY, or an idToken from POST /api/auth/login.
// Zetaris federates the query: rs_erp.* resolves to the PostgreSQL ERP over
// JDBC, rs_ref.* to CSV files in MinIO, rs_views.* to views over the REST
// supplier portal. Joins across them run inside Zetaris, so only the
// answer rows come back to the agents.
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { DataSource, QueryResult, QueryRow, SourceStatus, Value } from "./source.ts";

export class ZetarisError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

type ZetarisConfig = Config["zetaris"];

const SPARK_RESTART = /TTransportException|Could not create ResultSet/;

export class ZetarisSource implements DataSource {
  readonly mode = "zetaris" as const;
  readonly label: string;
  private token?: string;

  constructor(private cfg: ZetarisConfig, private fetchImpl: typeof fetch = fetch) {
    this.label = `Zetaris at ${cfg.baseUrl}`;
    if (!/^https?:\/\/[^/]+$/.test(cfg.baseUrl)) {
      throw new ZetarisError("ZETARIS_BASE_URL must be an origin without a path, for example http://localhost:3000");
    }
    if (!/^\d+$/.test(cfg.orgId)) {
      throw new ZetarisError("Set ZETARIS_ORG_ID to your numeric organisation ID (see docs/SETUP.md).");
    }
  }

  private async getToken(force = false): Promise<string> {
    if (this.cfg.apiKey) return this.cfg.apiKey;
    if (this.token && !force) return this.token;
    if (!this.cfg.username || !this.cfg.password) {
      throw new ZetarisError("Set ZETARIS_API_KEY, or ZETARIS_USERNAME and ZETARIS_PASSWORD, in .env");
    }
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ZetarisError(`Zetaris login failed: HTTP ${res.status}`, res.status);
    const body = (await res.json()) as Record<string, unknown>;
    const token = (body.idToken ?? body.token ?? body.accessToken) as string | undefined
      ?? JSON.stringify(body).match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)?.[0];
    if (!token) throw new ZetarisError("Zetaris login did not return an access token");
    this.token = token;
    return token;
  }

  private async request(pathname: string, method: "GET" | "POST", body?: unknown, retried = false): Promise<unknown> {
    const token = await this.getToken();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Org-ID": this.cfg.orgId,
          "X-Request-ID": randomUUID(),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      // A timed-out query may still be running in Spark, so resending it would pile up work.
      if ((err as Error).name === "TimeoutError") {
        throw new ZetarisError(`Zetaris did not answer within ${this.cfg.timeoutMs} ms (ZETARIS_TIMEOUT_MS)`, undefined, false);
      }
      throw new ZetarisError(`Cannot reach Zetaris at ${this.cfg.baseUrl}: ${(err as Error).message}`, undefined, true);
    }
    if (res.status === 401 && !retried && !this.cfg.apiKey) {
      await this.getToken(true);
      return this.request(pathname, method, body, true);
    }
    if (!res.ok) {
      const type = res.headers.get("content-type") ?? "";
      const detail = type.includes("text/html")
        ? "The server returned an HTML page. ZETARIS_BASE_URL must be the UI origin (port 3000 locally)."
        : (await res.text()).slice(0, 600);
      // Spark on a small cluster sometimes drops a query and restarts its SQL server (about 90 s).
      const sparkRestart = SPARK_RESTART.test(detail);
      throw new ZetarisError(`${method} ${pathname} failed: HTTP ${res.status} ${detail}`, res.status, sparkRestart || [429, 502, 503, 504].includes(res.status));
    }
    return res.status === 204 ? null : res.json();
  }

  async query(sql: string): Promise<QueryResult> {
    const t0 = performance.now();
    const body: Record<string, unknown> = { sql, limit: this.cfg.queryLimit };
    if (this.cfg.engineId) body.engineId = this.cfg.engineId;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await this.request("/api/proxy/sql-editor/sqls/run-query", "POST", body);
        const result = normalizeZetarisResult(raw);
        return { ...result, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ZetarisError) || !err.retryable) break;
        const wait = SPARK_RESTART.test(err.message) ? 45_000 * (attempt + 1) : err.status === 429 ? 15_000 : 1_500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  async status(): Promise<SourceStatus> {
    try {
      const dbs = await this.request("/api/proxy/lightning-database/databases", "GET");
      const count = Array.isArray(dbs) ? dbs.length : "unknown";
      return { ok: true, mode: "zetaris", detail: `Connected to ${this.cfg.baseUrl}. Lightning databases visible: ${count}` };
    } catch (err) {
      return { ok: false, mode: "zetaris", detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {}
}

/**
 * The run-query response carries a `data` array of rows (objects, or arrays
 * matched to `headers`). Accept the shapes seen across Zetaris versions and
 * fail loudly on an error payload.
 */
export function normalizeZetarisResult(raw: unknown): { rows: QueryRow[]; columns: string[] } {
  const body = findResultObject(raw);
  if (!body) {
    const err = extractError(raw);
    throw new ZetarisError(err ?? `Unexpected Zetaris response: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const headerSource = (body.headers ?? body.columns ?? body.schema ?? body.columnNames ?? []) as unknown[];
  let columns = headerSource
    .map((h) => (typeof h === "string" ? h : (h as Record<string, unknown>)?.name ?? (h as Record<string, unknown>)?.columnName))
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.toLowerCase());
  const data = body.data as unknown[];
  const rows: QueryRow[] = data.map((row) => {
    const out: QueryRow = {};
    if (Array.isArray(row)) {
      row.forEach((v, i) => (out[columns[i] ?? `col${i}`] = toValue(v)));
    } else if (row && typeof row === "object") {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) out[k.toLowerCase()] = toValue(v);
    }
    return out;
  });
  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  return { rows, columns };
}

function findResultObject(raw: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || depth > 3) return undefined;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj;
  for (const key of ["result", "results", "response", "payload", "body"]) {
    const inner = obj[key];
    if (Array.isArray(inner) && inner.length && typeof inner[0] === "object" && !Array.isArray(inner[0]) && Array.isArray((inner[0] as Record<string, unknown>).data)) {
      return inner[0] as Record<string, unknown>;
    }
    const found = findResultObject(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function extractError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const msg = obj.error ?? obj.errorMessage ?? obj.message ?? obj.detail;
  return typeof msg === "string" ? `Zetaris query failed: ${msg}` : undefined;
}

function toValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return JSON.stringify(v);
}
