// The Lightning SQL statements that register the three source systems in
// Zetaris. Syntax follows the Zetaris Lightning command reference
// (github.com/zetaris/getting-started docs/guides/zetaris-lightning-sql-commands.md):
//   CREATE DATASOURCE ... OPTIONS (jdbcdriver, jdbcurl, username, password)
//   REGISTER DATASOURCE TABLES ('t1', ...) FROM <datasource>
//   CREATE LIGHTNING DATABASE <name> DESCRIBE BY "<text>"
//   CREATE LIGHTNING FILESTORE TABLE <t> FROM <db> FORMAT CSV OPTIONS (PATH "s3a://...", s3Endpoint, ...)
//   CREATE LIGHTNING REST TABLE <t> FROM <db> REQUEST (...) HEADER () BODY ()
//   CREATE SCHEMASTORE CONTAINER <c>
//   CREATE OR REPLACE SCHEMASTORE VIEW <v> WITH CONTAINER <c> AS SELECT ... LATERAL VIEW explode(data) AS d
import { config } from "../config.ts";
import { TABLES } from "./schema.ts";

export interface SetupStatement {
  step: string;
  sql: string;
  /** SQL with credentials masked, for printing. */
  display: string;
}

export function setupStatements(): SetupStatement[] {
  const src = config.sources;
  const out: SetupStatement[] = [];
  const add = (step: string, sql: string, secrets: string[] = []) => {
    let display = sql;
    for (const sec of secrets.filter(Boolean)) display = display.split(sec).join("****");
    out.push({ step, sql, display });
  };

  // 1. ERP: PostgreSQL over JDBC.
  add("erp-datasource", `CREATE DATASOURCE rs_erp DESCRIBE BY "Harbourside ERP - PostgreSQL" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "${src.erpJdbcUrl}",
  username "${src.erpUser}",
  password "${src.erpPassword}",
  fetchsize "1000"
)`, [src.erpPassword]);
  const erpTables = TABLES.filter((t) => t.group === "rs_erp").map((t) => `'${t.table}'`).join(", ");
  add("erp-tables", `REGISTER DATASOURCE TABLES (${erpTables}) FROM rs_erp`);

  // 2. Reference lists: CSV files in S3-compatible storage.
  add("ref-database", `CREATE LIGHTNING DATABASE rs_ref DESCRIBE BY "Reference lists - sanctions, forced labour goods, product taxonomy, sector risk"`);
  for (const t of TABLES.filter((x) => x.group === "rs_ref")) {
    add(`ref-${t.table}`, `CREATE LIGHTNING FILESTORE TABLE ${t.table} FROM rs_ref FORMAT CSV OPTIONS (
  PATH "s3a://${src.refS3Bucket}/${t.table}/",
  s3Endpoint "${src.refS3Endpoint}",
  AWSACCESSKEYID "${src.refS3AccessKey}",
  AWSSECRETACCESSKEY "${src.refS3SecretKey}",
  useS3PathStyleAccess "true",
  header "true",
  inferSchema "true"
)`, [src.refS3SecretKey, src.refS3AccessKey]);
  }

  // 3. Supplier portal: JSON REST endpoint, flattened by a SchemaStore view.
  add("portal-database", `CREATE LIGHTNING DATABASE rs_portal DESCRIBE BY "Supplier declaration portal - REST"`);
  add("portal-rest-table", `CREATE LIGHTNING REST TABLE declarations_raw FROM rs_portal REQUEST (
  endpoint "${src.portalUrl}",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ()`);
  add("views-container", `CREATE SCHEMASTORE CONTAINER rs_views`);
  const decl = TABLES.find((t) => t.group === "rs_views" && t.table === "declarations")!;
  const cols = Object.keys(decl.columns).map((c) => `d.${c} AS ${c}`).join(",\n       ");
  add("portal-view", `CREATE OR REPLACE SCHEMASTORE VIEW declarations WITH CONTAINER rs_views AS
SELECT ${cols}
FROM rs_portal.declarations_raw
LATERAL VIEW explode(data) AS d`);
  return out;
}

export const teardownStatements = (): string[] => [
  ...TABLES.filter((t) => t.group === "rs_ref").map((t) => `DROP LIGHTNING DATABASE TABLE rs_ref.${t.table}`),
  "DROP LIGHTNING DATABASE rs_ref",
  "DROP LIGHTNING DATABASE TABLE rs_portal.declarations_raw",
  "DROP LIGHTNING DATABASE rs_portal",
  "DROP DATASOURCE rs_erp",
];
