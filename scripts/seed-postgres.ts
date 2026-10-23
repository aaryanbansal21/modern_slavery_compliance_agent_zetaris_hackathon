// Load the ERP tables (suppliers, purchase lines, company registers) into
// PostgreSQL. Zetaris reads them over JDBC as the rs_erp datasource.
//   npm run seed:postgres
import pg from "pg";
import { config } from "../src/config.ts";
import { buildRows, prepareData } from "../src/data/prepare.ts";
import { TABLES, type ColType } from "../src/data/schema.ts";

const PG_TYPES: Record<ColType, string> = { VARCHAR: "text", DOUBLE: "double precision", DATE: "date", BOOLEAN: "boolean", INTEGER: "integer" };

prepareData((m) => console.log(m));
const client = new pg.Client({ ...config.postgres });
await client.connect();
console.log(`Connected to PostgreSQL at ${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`);

for (const t of TABLES.filter((x) => x.group === "rs_erp")) {
  const cols = Object.entries(t.columns);
  await client.query(`DROP TABLE IF EXISTS public.${t.table}`);
  await client.query(`CREATE TABLE public.${t.table} (${cols.map(([c, type]) => `${c} ${PG_TYPES[type]}`).join(", ")})`);
  const rows = buildRows(t.file);
  for (const r of rows) {
    const values = cols.map(([c, type]) => {
      const v = r[c];
      if (v === undefined || v === "") return null;
      if (type === "DOUBLE" || type === "INTEGER") return Number(v);
      if (type === "BOOLEAN") return v === "true";
      return v;
    });
    await client.query(
      `INSERT INTO public.${t.table} (${cols.map(([c]) => c).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      values,
    );
  }
  console.log(`  public.${t.table}: ${rows.length} rows`);
}
await client.end();
console.log("ERP seeded. Next: npm run upload:minio");
