// Data preparation. Reads the demo ERP extracts, the supplier portal export
// and the reference lists, adds normalized name columns, and writes one
// processed CSV per table into .data/build. Postgres seeding, the MinIO
// upload and the offline DuckDB stand-in all load these same files.
import fs from "node:fs";
import path from "node:path";
import { ROOT, config } from "../config.ts";
import { parseCsv, toCsv, type Row } from "../util/csv.ts";
import { companyKey, emailDomain, normalizeEntityName, sortedTokens } from "../util/names.ts";
import { TABLES } from "./schema.ts";

export const DEMO_DIR = path.join(ROOT, "data", "demo");
export const REF_DIR = path.join(ROOT, "data", "reference");
// Tests point this at a missing folder so they always use the bundled fixture and excerpt.
export const FETCHED_DIR = process.env.REF_FETCHED_DIR ?? path.join(REF_DIR, "fetched");
export const buildDir = () => path.join(config.dataDir, "build");

export interface BuildManifest {
  builtAt: string;
  sanctions: { source: "DFAT" | "TEST_FIXTURE"; rows: number; file: string; note: string };
  dolGoods: { source: "DOL_FULL" | "DOL_EXCERPT"; rows: number; file: string; note: string };
  tables: Record<string, number>;
}

const read = (file: string): Row[] => parseCsv(fs.readFileSync(file, "utf8"));
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === "";

export interface Declaration {
  decl_id: string;
  supplier_name: string;
  abn: string;
  respondent_email: string;
  submitted_at: string;
  origin_countries: string;
  manufacturers: string;
  has_code_of_conduct: boolean;
  third_party_audit: string;
  recruitment_fees_policy: string;
  notes: string;
}

export function readDeclarationsJson(file = path.join(DEMO_DIR, "declarations.json")): Declaration[] {
  const body = JSON.parse(fs.readFileSync(file, "utf8")) as { data: Declaration[] };
  return body.data;
}

export function prepareData(log: (msg: string) => void = () => {}): BuildManifest {
  const out = buildDir();
  fs.mkdirSync(out, { recursive: true });
  const counts: Record<string, number> = {};
  const write = (file: string, rows: Record<string, unknown>[]) => {
    const def = TABLES.find((t) => t.file === file)!;
    fs.writeFileSync(path.join(out, file), toCsv(rows, Object.keys(def.columns)));
    counts[`${def.group}.${def.table}`] = rows.length;
  };

  // ERP: suppliers
  const suppliers = read(path.join(DEMO_DIR, "suppliers.csv")).map((s) => {
    const norm = normalizeEntityName(s.name);
    const parentNorm = normalizeEntityName(s.parent_company);
    return {
      ...s,
      name_norm: norm,
      name_sorted: sortedTokens(norm),
      match_key: companyKey(s.name),
      parent_norm: parentNorm,
      parent_sorted: sortedTokens(parentNorm),
      email_domain: emailDomain(s.contact_email),
    };
  });
  write("erp_suppliers.csv", suppliers);

  // ERP: purchase lines
  const lines = read(path.join(DEMO_DIR, "purchase_lines.csv")).map((l) => {
    const norm = normalizeEntityName(l.manufacturer);
    return { ...l, manufacturer_norm: norm, manufacturer_sorted: sortedTokens(norm), manufacturer_key: companyKey(l.manufacturer) };
  });
  write("erp_purchase_lines.csv", lines);

  // ERP: company profile
  write("erp_company_profile.csv", read(path.join(DEMO_DIR, "company_profile.csv")));

  // Reference: sanctions. Prefer the real DFAT list fetched by `npm run fetch:data`.
  const fetchedDfat = path.join(FETCHED_DIR, "dfat_sanctions.csv");
  let sanctionsSource: BuildManifest["sanctions"]["source"] = "TEST_FIXTURE";
  let sanctionsRows: Row[];
  if (fs.existsSync(fetchedDfat)) {
    sanctionsSource = "DFAT";
    sanctionsRows = read(fetchedDfat);
  } else {
    sanctionsRows = read(path.join(REF_DIR, "sanctions_test_fixture.csv")).map((r) => ({
      list_id: r.list_id, name: r.name, name_type: "Primary Name", entity_type: r.entity_type,
      citizenship: r.country, address: "", regime: r.program, listed_on: r.listed_on, source: r.source,
      source_url: "data/reference/sanctions_test_fixture.csv",
    }));
  }
  const sanctions = sanctionsRows
    .filter((r) => !blank(r.name))
    .map((r) => {
      const norm = normalizeEntityName(r.name);
      return { ...r, name_norm: norm, name_sorted: sortedTokens(norm) };
    })
    .filter((r) => r.name_norm.length > 0);
  write("ref_dfat_sanctions.csv", sanctions);

  // Reference: DOL List of Goods. Prefer the full list fetched by `npm run fetch:data`.
  const fetchedDol = path.join(FETCHED_DIR, "dol_goods.csv");
  const dolSource: BuildManifest["dolGoods"]["source"] = fs.existsSync(fetchedDol) ? "DOL_FULL" : "DOL_EXCERPT";
  const dol = read(dolSource === "DOL_FULL" ? fetchedDol : path.join(REF_DIR, "dol_goods_excerpt.csv"));
  write("ref_dol_goods.csv", dol);

  write("ref_good_keywords.csv", read(path.join(REF_DIR, "good_keywords.csv")));
  write("ref_sector_risk.csv", read(path.join(REF_DIR, "sector_risk.csv")));

  // Supplier portal export, flattened for the offline stand-in. In Zetaris
  // mode the same JSON is served over HTTP and registered as a REST table.
  write("portal_declarations.csv", readDeclarationsJson() as unknown as Record<string, unknown>[]);

  const manifest: BuildManifest = {
    builtAt: new Date().toISOString(),
    sanctions: {
      source: sanctionsSource,
      rows: sanctions.length,
      file: sanctionsSource === "DFAT" ? "data/reference/fetched/dfat_sanctions.csv" : "data/reference/sanctions_test_fixture.csv",
      note: sanctionsSource === "DFAT"
        ? "Australian Sanctions Consolidated List downloaded from dfat.gov.au"
        : "TEST FIXTURE with synthetic names. Not real sanctions data. Run `npm run fetch:data` to use the DFAT list.",
    },
    dolGoods: {
      source: dolSource,
      rows: dol.length,
      file: dolSource === "DOL_FULL" ? "data/reference/fetched/dol_goods.csv" : "data/reference/dol_goods_excerpt.csv",
      note: dolSource === "DOL_FULL"
        ? "Full 2024 List of Goods downloaded from dol.gov"
        : "Excerpt of the 2024 List of Goods for the countries in the demo, copied from dol.gov country pages",
    },
    tables: counts,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`Prepared ${Object.keys(counts).length} tables in ${out} (sanctions: ${manifest.sanctions.source}, goods: ${manifest.dolGoods.source})`);
  return manifest;
}

export function readManifest(): BuildManifest | undefined {
  const file = path.join(buildDir(), "manifest.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as BuildManifest) : undefined;
}

/** Rows of a processed table, for seeding Postgres and uploading to MinIO. */
export function buildRows(file: string): Row[] {
  return read(path.join(buildDir(), file));
}
