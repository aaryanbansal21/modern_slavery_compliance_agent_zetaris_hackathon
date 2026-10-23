// Logged access to the data layer. Every query gets an ID (Q-1, Q-2, ...),
// and its SQL, the tables and source systems it touched, its row count and
// its timing go into the evidence pack and the reasoning trace. Answers cite
// evidence, evidence cites queries, so a reader can follow any claim back to
// the SQL that Zetaris ran.
import { config } from "../config.ts";
import type { Trace } from "../trace/trace.ts";
import { LocalDuckDbSource } from "./local.ts";
import { buildDir, prepareData, readManifest } from "./prepare.ts";
import { systemOf, tablesInSql } from "./schema.ts";
import type { DataSource, QueryRow } from "./source.ts";
import { ZetarisSource } from "./zetaris.ts";

export interface QueryRecord {
  id: string;
  iteration: number;
  tool: string;
  purpose: string;
  sql: string;
  tables: string[];
  systems: string[];
  mode: "zetaris" | "local";
  rowCount: number;
  ms: number;
  ok: boolean;
  error?: string;
  sample: QueryRow[];
  at: string;
}

export class FederatedData {
  readonly queries: QueryRecord[] = [];

  constructor(readonly source: DataSource, private trace?: Trace) {}

  get mode() {
    return this.source.mode;
  }

  attach(trace: Trace) {
    this.trace = trace;
  }

  async run(tool: string, purpose: string, sql: string): Promise<{ rows: QueryRow[]; record: QueryRecord }> {
    const id = `Q-${this.queries.length + 1}`;
    const tables = tablesInSql(sql);
    const systems = [...new Set(tables.map(systemOf))];
    const base = {
      id, iteration: this.trace?.iteration ?? 0, tool, purpose, sql: sql.trim(), tables, systems,
      mode: this.source.mode, at: new Date().toISOString(),
    };
    try {
      const result = await this.source.query(sql);
      const record: QueryRecord = { ...base, rowCount: result.rows.length, ms: result.ms, ok: true, sample: result.rows.slice(0, 25) };
      this.queries.push(record);
      this.trace?.log("zetaris", "query", `${id} ${purpose}`, {
        detail: `${result.rows.length} rows from ${systems.join(" + ")} in ${result.ms} ms`,
        data: { queryId: id, tool, tables, systems, rowCount: result.rows.length, sql: record.sql, mode: this.source.mode },
        ms: result.ms,
      });
      return { rows: result.rows, record };
    } catch (err) {
      const record: QueryRecord = { ...base, rowCount: 0, ms: 0, ok: false, error: (err as Error).message, sample: [] };
      this.queries.push(record);
      this.trace?.log("zetaris", "error", `${id} failed: ${purpose}`, { detail: record.error, data: { queryId: id, sql: record.sql } });
      throw err;
    }
  }

  query(id: string): QueryRecord | undefined {
    return this.queries.find((q) => q.id === id);
  }
}

/** Open the configured data source (Zetaris or the offline stand-in). */
export async function openDataSource(mode = config.dataMode): Promise<DataSource> {
  if (mode === "zetaris") return new ZetarisSource(config.zetaris);
  if (!readManifest()) prepareData();
  return LocalDuckDbSource.open(buildDir());
}
