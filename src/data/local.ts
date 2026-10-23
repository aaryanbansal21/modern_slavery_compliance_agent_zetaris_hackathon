// Offline stand-in for Zetaris: an embedded DuckDB loaded with the same
// processed tables, under the same schema.table names. Used for tests and
// development without the Zetaris platform running. The demo and the
// submission run in DATA_MODE=zetaris.
import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { TABLES } from "./schema.ts";
import type { DataSource, QueryResult, QueryRow, SourceStatus, Value } from "./source.ts";

export class LocalDuckDbSource implements DataSource {
  readonly mode = "local" as const;
  readonly label = "Local DuckDB stand-in (offline)";

  private constructor(private conn: DuckDBConnection, private instance: DuckDBInstance) {}

  static async open(buildDir: string): Promise<LocalDuckDbSource> {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const groups = [...new Set(TABLES.map((t) => t.group))];
    for (const g of groups) await conn.run(`CREATE SCHEMA IF NOT EXISTS ${g}`);
    for (const t of TABLES) {
      const file = path.join(buildDir, t.file);
      if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run \`npm run prepare:data\` first.`);
      const cols = Object.entries(t.columns).map(([c, type]) => `'${c}': '${type}'`).join(", ");
      const escaped = file.replace(/'/g, "''");
      await conn.run(
        `CREATE OR REPLACE TABLE ${t.group}.${t.table} AS SELECT * FROM read_csv('${escaped}', header = true, columns = {${cols}})`,
      );
    }
    return new LocalDuckDbSource(conn, instance);
  }

  async query(sql: string): Promise<QueryResult> {
    const t0 = performance.now();
    const reader = await this.conn.runAndReadAll(sql);
    const columns = reader.columnNames();
    const raw = reader.getRowObjectsJson() as Record<string, unknown>[];
    const rows: QueryRow[] = raw.map((r) => {
      const out: QueryRow = {};
      for (const c of columns) out[c.toLowerCase()] = toValue(r[c]);
      return out;
    });
    return { rows, columns: columns.map((c) => c.toLowerCase()), ms: Math.round(performance.now() - t0) };
  }

  async status(): Promise<SourceStatus> {
    try {
      const r = await this.query("SELECT COUNT(*) AS n FROM rs_erp.purchase_lines");
      return { ok: true, mode: "local", detail: `DuckDB stand-in loaded (${r.rows[0]?.n} purchase lines)` };
    } catch (err) {
      return { ok: false, mode: "local", detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync?.();
  }
}

function toValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
