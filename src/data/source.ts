// The data-layer contract. In "zetaris" mode every query goes to Zetaris,
// which federates the PostgreSQL ERP, the MinIO reference files and the REST
// supplier portal. In "local" mode an embedded DuckDB holds the same tables
// under the same names, for offline development and tests.

export type Value = string | number | boolean | null;
export type QueryRow = Record<string, Value>;

export interface QueryResult {
  rows: QueryRow[];
  columns: string[];
  ms: number;
}

export interface SourceStatus {
  ok: boolean;
  mode: "zetaris" | "local";
  detail: string;
}

export interface DataSource {
  readonly mode: "zetaris" | "local";
  readonly label: string;
  query(sql: string): Promise<QueryResult>;
  status(): Promise<SourceStatus>;
  close(): Promise<void>;
}

/** Make a value safe to embed as a SQL string literal in both Spark SQL and DuckDB. */
export function lit(value: string | null | undefined): string {
  const clean = String(value ?? "")
    .replace(/['\\`]/g, "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim();
  return `'${clean}'`;
}

export function litList(values: string[]): string {
  const uniq = [...new Set(values.map((v) => String(v)))];
  return uniq.length ? uniq.map(lit).join(", ") : "''";
}

export function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  return String(value);
}

export function sqlDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Not an ISO date: ${value}`);
  return `CAST('${value}' AS DATE)`;
}

/** Coerce numbers that arrive as strings (BIGINT, DECIMAL) back to numbers. */
export function n(value: Value | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return 0;
}

export function s(value: Value | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function b(value: Value | undefined): boolean {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "y"].includes(String(value ?? "").trim().toLowerCase());
}
