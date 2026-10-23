// Minimal RFC 4180 CSV reader and writer. Fields are written on a single line
// (embedded newlines collapse to spaces) because Spark's CSV reader, which
// Zetaris uses for filestore tables, reads one record per line by default.

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const row: Row = {};
    header.forEach((h, idx) => (row[h] = (r[idx] ?? "").trim()));
    return row;
  });
}

// Double quotes inside values become single quotes: Spark's CSV reader uses a
// backslash escape by default, so RFC 4180 doubled quotes would not parse.
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).replace(/[\r\n]+/g, " ").replace(/"/g, "'").replace(/\\/g, "/").trim();
  return /,/.test(s) ? `"${s}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return lines.join("\n") + "\n";
}
