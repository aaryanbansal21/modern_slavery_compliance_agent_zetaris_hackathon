// One schema definition for every table the agents query. The same names
// exist in Zetaris (rs_erp = PostgreSQL datasource, rs_ref = Lightning
// filestore over MinIO, rs_views = SchemaStore views over the REST portal) and
// in the offline DuckDB stand-in, so every query template runs unchanged in
// both modes.

export type ColType = "VARCHAR" | "DOUBLE" | "DATE" | "BOOLEAN" | "INTEGER";

export interface TableDef {
  /** Logical group in Zetaris: datasource, lightning database or schemastore container. */
  group: "rs_erp" | "rs_ref" | "rs_views";
  table: string;
  /** Processed file written by the data-prep step. */
  file: string;
  system: string;
  description: string;
  columns: Record<string, ColType>;
}

export const TABLES: TableDef[] = [
  {
    group: "rs_erp", table: "suppliers", file: "erp_suppliers.csv", system: "ERP (PostgreSQL)",
    description: "Supplier master from the accounting system",
    columns: {
      supplier_id: "VARCHAR", name: "VARCHAR", name_norm: "VARCHAR", name_sorted: "VARCHAR", match_key: "VARCHAR",
      abn: "VARCHAR", country: "VARCHAR", state: "VARCHAR", category: "VARCHAR",
      parent_company: "VARCHAR", parent_norm: "VARCHAR", parent_sorted: "VARCHAR",
      annual_spend_aud: "DOUBLE", contact_email: "VARCHAR", email_domain: "VARCHAR",
    },
  },
  {
    group: "rs_erp", table: "purchase_lines", file: "erp_purchase_lines.csv", system: "ERP (PostgreSQL)",
    description: "Invoice lines for the last 12 months",
    columns: {
      line_id: "VARCHAR", supplier_id: "VARCHAR", invoice_no: "VARCHAR", invoice_date: "DATE", description: "VARCHAR",
      sku: "VARCHAR", quantity: "DOUBLE", unit: "VARCHAR", amount_aud: "DOUBLE", origin_country: "VARCHAR",
      manufacturer: "VARCHAR", manufacturer_norm: "VARCHAR", manufacturer_sorted: "VARCHAR", manufacturer_key: "VARCHAR",
    },
  },
  {
    group: "rs_erp", table: "company_profile", file: "erp_company_profile.csv", system: "ERP (PostgreSQL)",
    description: "Policies, controls and registers for the business",
    columns: { item: "VARCHAR", detail: "VARCHAR", source: "VARCHAR", updated_at: "DATE" },
  },
  {
    group: "rs_ref", table: "dfat_sanctions", file: "ref_dfat_sanctions.csv", system: "Object storage (MinIO / S3)",
    description: "Australian Sanctions Consolidated List (DFAT), names and aliases",
    columns: {
      list_id: "VARCHAR", name: "VARCHAR", name_norm: "VARCHAR", name_sorted: "VARCHAR", name_type: "VARCHAR",
      entity_type: "VARCHAR", citizenship: "VARCHAR", address: "VARCHAR", regime: "VARCHAR", listed_on: "VARCHAR",
      source: "VARCHAR", source_url: "VARCHAR",
    },
  },
  {
    group: "rs_ref", table: "dol_goods", file: "ref_dol_goods.csv", system: "Object storage (MinIO / S3)",
    description: "US Department of Labor List of Goods Produced by Child Labor or Forced Labor",
    columns: { country: "VARCHAR", good: "VARCHAR", exploitation_type: "VARCHAR", list_year: "INTEGER", source_url: "VARCHAR" },
  },
  {
    group: "rs_ref", table: "good_keywords", file: "ref_good_keywords.csv", system: "Object storage (MinIO / S3)",
    description: "Product taxonomy that maps purchase descriptions to listed goods",
    columns: { keyword: "VARCHAR", good: "VARCHAR", note: "VARCHAR" },
  },
  {
    group: "rs_ref", table: "sector_risk", file: "ref_sector_risk.csv", system: "Object storage (MinIO / S3)",
    description: "Sectors recognised as high risk for modern slavery",
    columns: { keyword: "VARCHAR", sector: "VARCHAR", basis: "VARCHAR", source_url: "VARCHAR" },
  },
  {
    group: "rs_views", table: "declarations", file: "portal_declarations.csv", system: "Supplier portal (REST API)",
    description: "Supplier self-declarations, typed by suppliers, with no internal IDs",
    columns: {
      decl_id: "VARCHAR", supplier_name: "VARCHAR", abn: "VARCHAR", respondent_email: "VARCHAR", submitted_at: "VARCHAR",
      origin_countries: "VARCHAR", manufacturers: "VARCHAR", has_code_of_conduct: "BOOLEAN",
      third_party_audit: "VARCHAR", recruitment_fees_policy: "VARCHAR", notes: "VARCHAR",
    },
  },
];

export const tableRef = (t: TableDef) => `${t.group}.${t.table}`;

export function tableByRef(ref: string): TableDef | undefined {
  return TABLES.find((t) => tableRef(t) === ref);
}

/** Which source system a fully qualified table name belongs to. */
export function systemOf(ref: string): string {
  return tableByRef(ref)?.system ?? "unknown";
}

/** Extract fully qualified table references from SQL text. */
export function tablesInSql(sql: string): string[] {
  const refs = new Set<string>();
  for (const t of TABLES) {
    const re = new RegExp(`\\b${t.group}\\.${t.table}\\b`, "i");
    if (re.test(sql)) refs.add(tableRef(t));
  }
  return [...refs].sort();
}
