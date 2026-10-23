// Download the two public reference lists and convert them to CSV:
//   - Australian Sanctions Consolidated List (DFAT)
//   - US DOL List of Goods Produced by Child Labor or Forced Labor (2024)
//
//   npm run fetch:data
//   npm run fetch:data -- --dfat-file=~/Downloads/consolidated.xlsx --dol-file=~/Downloads/2024ListofGoodsExcel.xlsx
//
// Writes data/reference/fetched/*.csv (gitignored), then rebuilds the tables.
// If a download is blocked, download the file in a browser and pass its path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { FETCHED_DIR, prepareData } from "../src/data/prepare.ts";
import { toCsv } from "../src/util/csv.ts";

const DFAT_PAGE = "https://www.dfat.gov.au/international-relations/security/sanctions/consolidated-list";
const DFAT_CANDIDATES = [
  "https://www.dfat.gov.au/sites/default/files/regulation8_consolidated.xlsx",
  "https://www.dfat.gov.au/sites/default/files/Australian_Sanctions_Consolidated_List.xlsx",
];
const DOL_URL = "https://www.dol.gov/sites/dolgov/files/ilab/child_labor_reports/tda2023/2024ListofGoodsExcel.xlsx";
const DOL_PAGE = "https://www.dol.gov/agencies/ilab/reports/child-labor/list-of-goods";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": "slavery-compliance-agent hackathon prototype" }, signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) throw new Error(`Got an HTML page instead of a spreadsheet from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function findLinkOnPage(page: string, pattern: RegExp): Promise<string | undefined> {
  const res = await fetch(page, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return undefined;
  const html = await res.text();
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const hit = hrefs.find((h) => pattern.test(h));
  return hit ? new URL(hit, page).toString() : undefined;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return String(v.result ?? "");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

async function readSheet(buf: Buffer, headerTest: (cells: string[]) => boolean): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      rows.push(vals);
    });
    const headerIdx = rows.findIndex(headerTest);
    if (headerIdx < 0) continue;
    // A repeated header gets its column number appended so neither column is lost.
    const header = rows[headerIdx].map((h) => h.replace(/\s+/g, " ").trim()).map((h, i, all) => (all.indexOf(h) < i ? `${h} ${i + 1}` : h));
    return rows.slice(headerIdx + 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").replace(/\s+/g, " ").trim()])));
  }
  throw new Error("Could not find the header row in the spreadsheet");
}

const col = (row: Record<string, string>, re: RegExp) => {
  const key = Object.keys(row).find((k) => re.test(k));
  return key ? row[key] : "";
};

async function dfat(): Promise<void> {
  let buf: Buffer | undefined;
  const local = arg("dfat-file");
  if (local) buf = fs.readFileSync(expand(local));
  else {
    const urls = [...DFAT_CANDIDATES];
    try {
      const found = await findLinkOnPage(DFAT_PAGE, /consolidated.*\.xlsx?$|\.xlsx$/i);
      if (found) urls.unshift(found);
    } catch {
      // page unreachable, try the known file names
    }
    for (const u of urls) {
      try {
        buf = await download(u);
        console.log(`DFAT: downloaded ${u}`);
        break;
      } catch (err) {
        console.log(`DFAT: ${(err as Error).message}`);
      }
    }
  }
  if (!buf) {
    console.log(`DFAT: download failed. Open ${DFAT_PAGE}, download the Consolidated List (XLSX) and run:\n  npm run fetch:data -- --dfat-file=<path to the file>`);
    return;
  }
  const rows = await readSheet(buf, (cells) => cells.some((c) => /name of individual or entity|^name$/i.test(c)));
  const out = rows
    .map((r) => ({
      list_id: col(r, /^reference/i) || col(r, /ref/i),
      name: col(r, /name of individual or entity|^name$/i),
      name_type: col(r, /name type/i) || "Primary Name",
      entity_type: col(r, /^type$/i) || col(r, /individual or entity type/i),
      citizenship: col(r, /citizenship|nationality/i),
      address: col(r, /address/i).slice(0, 200),
      regime: col(r, /committees|regime/i).slice(0, 120),
      listed_on: col(r, /control date|listing date|date of listing/i),
      source: "DFAT",
      source_url: DFAT_PAGE,
    }))
    .filter((r) => r.name);
  fs.mkdirSync(FETCHED_DIR, { recursive: true });
  fs.writeFileSync(path.join(FETCHED_DIR, "dfat_sanctions.csv"), toCsv(out));
  console.log(`DFAT: ${out.length} names and aliases written`);
}

async function dol(): Promise<void> {
  let buf: Buffer | undefined;
  const local = arg("dol-file");
  try {
    buf = local ? fs.readFileSync(expand(local)) : await download(DOL_URL);
  } catch (err) {
    try {
      const found = await findLinkOnPage(DOL_PAGE, /ListofGoods.*\.xlsx$/i);
      if (found) buf = await download(found);
    } catch {
      // fall through
    }
    if (!buf) {
      console.log(`DOL: ${(err as Error).message}. Download the Excel list from ${DOL_PAGE} and run:\n  npm run fetch:data -- --dol-file=<path to the file>`);
      return;
    }
  }
  const rows = await readSheet(buf, (cells) => cells.some((c) => /^good$/i.test(c)) && cells.some((c) => /country/i.test(c)));
  const out: Record<string, string>[] = [];
  for (const r of rows) {
    const country = col(r, /country/i);
    const good = col(r, /^good$/i);
    if (!country || !good) continue;
    const typeCol = col(r, /exploitation/i);
    const types = typeCol
      ? typeCol.split(/[;,\n]/).map((t) => t.trim()).filter(Boolean)
      : Object.keys(r).filter((k) => /labor/i.test(k) && r[k] && !/^(no|n|0)$/i.test(r[k])).map((k) => k.trim());
    for (const t of types) out.push({ country, good, exploitation_type: t, list_year: "2024", source_url: DOL_PAGE });
  }
  // Downstream goods are on their own sheet: an input good with Child Labor and
  // Forced Labor marks, then a second Country/Area column and the good made from
  // it, e.g. "Garments (Cotton)". The rubric keys these as "Inputs Produced with ..."
  // on the downstream country and good, without the bracketed input.
  try {
    const downstream = await readSheet(buf, (cells) => cells.some((c) => /downstream good/i.test(c)));
    for (const r of downstream) {
      const countryKey = Object.keys(r).filter((k) => /country/i.test(k)).at(-1);
      const country = countryKey ? r[countryKey] : "";
      const good = col(r, /downstream good$/i).replace(/\s*\(.*\)$/, "");
      if (!country || !good) continue;
      for (const t of ["Child Labor", "Forced Labor"]) {
        if (/^x$/i.test(col(r, new RegExp(`^${t}$`, "i")))) out.push({ country, good, exploitation_type: `Inputs Produced with ${t}`, list_year: "2024", source_url: DOL_PAGE });
      }
    }
  } catch {
    console.log("DOL: no Downstream Goods sheet found, so input-based risks (\"Inputs Produced with ...\") are missing. Check the workbook.");
  }
  const seen = new Set<string>();
  const unique = out.filter((r) => {
    const key = `${r.country}|${r.good}|${r.exploitation_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  fs.mkdirSync(FETCHED_DIR, { recursive: true });
  fs.writeFileSync(path.join(FETCHED_DIR, "dol_goods.csv"), toCsv(unique));
  console.log(`DOL: ${unique.length} good, country and exploitation rows written (${unique.filter((r) => r.exploitation_type.startsWith("Inputs")).length} from Downstream Goods)`);
}

await dfat();
await dol();
const m = prepareData();
console.log(`\nTables rebuilt. Sanctions list: ${m.sanctions.source} (${m.sanctions.rows} names). Goods list: ${m.dolGoods.source} (${m.dolGoods.rows} rows).`);
if (m.sanctions.source === "DFAT") console.log("If you use Zetaris, run `npm run upload:minio` so Zetaris serves the new lists.");
