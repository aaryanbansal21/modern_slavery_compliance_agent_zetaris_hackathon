// Check every table through Zetaris and run every agent query template once,
// comparing row counts with the local build. Run this after zetaris:setup and
// before recording the demo.
//   npm run zetaris:verify
import { config } from "../src/config.ts";
import { Q } from "../src/data/queries.ts";
import { buildDir, prepareData } from "../src/data/prepare.ts";
import { LocalDuckDbSource } from "../src/data/local.ts";
import { TABLES, tableRef } from "../src/data/schema.ts";
import { ZetarisSource } from "../src/data/zetaris.ts";

prepareData();
const zetaris = new ZetarisSource(config.zetaris);
const local = await LocalDuckDbSource.open(buildDir());
const status = await zetaris.status();
console.log(status.detail);
if (!status.ok) process.exit(1);

let problems = 0;
console.log("\nTables");
for (const t of TABLES) {
  const ref = tableRef(t);
  const expected = Number((await local.query(Q.tableCount(ref))).rows[0]?.row_count ?? 0);
  try {
    const got = Number((await zetaris.query(Q.tableCount(ref))).rows[0]?.row_count ?? 0);
    const ok = got === expected;
    if (!ok) problems++;
    console.log(`  ${ok ? "ok  " : "DIFF"} ${ref.padEnd(26)} ${got} rows${ok ? "" : ` (expected ${expected})`}  [${t.system}]`);
  } catch (err) {
    problems++;
    console.log(`  FAIL ${ref.padEnd(26)} ${(err as Error).message.slice(0, 200)}`);
  }
}

const from = "2025-10-24";
const templates: [string, string][] = [
  ["company profile", Q.companyProfile()],
  ["suppliers", Q.suppliers()],
  ["spend by supplier", Q.spendBySupplier(from)],
  ["declarations (REST view)", Q.declarations()],
  ["origin summary", Q.originSummary(from)],
  ["line origin screen (federated)", Q.lineOriginScreen(from)],
  ["line categories", Q.lineCategories(from)],
  ["declared inputs (federated)", Q.declaredInputsScreen()],
  ["sector risk (federated)", Q.sectorRisk()],
  ["sanctions screen (federated)", Q.sanctionsScreen([{ entityId: "test", name: "Pacific Star Trading Pty Ltd", norm: "pacific star trading", sorted: "pacific star trading" }], 0.85)],
];
console.log("\nAgent queries");
for (const [name, sql] of templates) {
  const expected = (await local.query(sql)).rows.length;
  try {
    const r = await zetaris.query(sql);
    const ok = r.rows.length === expected;
    if (!ok) problems++;
    console.log(`  ${ok ? "ok  " : "DIFF"} ${name.padEnd(32)} ${r.rows.length} rows in ${r.ms} ms${ok ? "" : ` (offline stand-in returns ${expected})`}`);
  } catch (err) {
    problems++;
    console.log(`  FAIL ${name.padEnd(32)} ${(err as Error).message.slice(0, 300)}`);
  }
}
await local.close();
console.log(problems ? `\n${problems} problems. See docs/SETUP.md, Troubleshooting.` : "\nZetaris is serving every table and query. Set DATA_MODE=zetaris and run the app.");
process.exit(problems ? 1 : 0);
