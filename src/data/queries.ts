// Federated query library. The agents choose from these tested templates
// (and set their parameters) instead of writing free-form SQL, so every query
// runs the same way in Spark SQL on Zetaris and in DuckDB offline.
//
// Portability rules followed here: no quoted identifiers, no dialect-only
// functions (only lower, trim, instr, concat, coalesce, nullif, length,
// levenshtein, greatest, round, cast, row_number), coalesce() around every
// concat() argument because Spark returns NULL when any argument is NULL, and
// string literals pass through lit(), which strips quote and escape
// characters because the two dialects escape them differently.
import { lit, litList, sqlDate, sqlNumber } from "./source.ts";

export const Q = {
  companyProfile: () => `
SELECT p.item, p.detail, p.source, p.updated_at
FROM rs_erp.company_profile p
ORDER BY p.item`,

  suppliers: () => `
SELECT s.supplier_id, s.name, s.match_key, s.abn, s.country, s.state, s.category, s.parent_company,
       s.annual_spend_aud, s.contact_email, s.email_domain
FROM rs_erp.suppliers s
ORDER BY s.supplier_id`,

  spendBySupplier: (from: string) => `
SELECT l.supplier_id,
       COUNT(*) AS line_count,
       ROUND(SUM(l.amount_aud), 2) AS spend_aud,
       SUM(CASE WHEN l.origin_country IS NULL OR TRIM(l.origin_country) = '' THEN 1 ELSE 0 END) AS unknown_origin_lines
FROM rs_erp.purchase_lines l
WHERE l.invoice_date >= ${sqlDate(from)}
GROUP BY l.supplier_id
ORDER BY l.supplier_id`,

  declarations: () => `
SELECT d.decl_id, d.supplier_name, d.abn, d.respondent_email, d.submitted_at, d.origin_countries,
       d.manufacturers, d.has_code_of_conduct, d.third_party_audit, d.recruitment_fees_policy, d.notes
FROM rs_views.declarations d
ORDER BY d.decl_id`,

  originSummary: (from: string) => `
SELECT COALESCE(NULLIF(TRIM(l.origin_country), ''), 'Unknown') AS origin,
       COUNT(*) AS line_count,
       ROUND(SUM(l.amount_aud), 2) AS spend_aud
FROM rs_erp.purchase_lines l
WHERE l.invoice_date >= ${sqlDate(from)}
GROUP BY COALESCE(NULLIF(TRIM(l.origin_country), ''), 'Unknown')
ORDER BY spend_aud DESC`,

  purchaseLines: (from: string) => `
SELECT l.line_id, l.supplier_id, s.name AS supplier_name, l.invoice_no, l.invoice_date, l.description,
       l.quantity, l.unit, l.amount_aud, l.origin_country, l.manufacturer, l.manufacturer_key
FROM rs_erp.purchase_lines l
JOIN rs_erp.suppliers s ON s.supplier_id = l.supplier_id
WHERE l.invoice_date >= ${sqlDate(from)}
ORDER BY l.line_id`,

  /** ERP purchase lines x product taxonomy x DOL List of Goods, matched on good and origin country. */
  lineOriginScreen: (from: string) => `
SELECT l.line_id, l.supplier_id, s.name AS supplier_name, l.invoice_no, l.invoice_date, l.description,
       l.amount_aud, l.origin_country, l.manufacturer, k.keyword, k.good,
       g.exploitation_type, g.list_year, g.source_url
FROM rs_erp.purchase_lines l
JOIN rs_erp.suppliers s ON s.supplier_id = l.supplier_id
JOIN rs_ref.good_keywords k ON instr(lower(l.description), k.keyword) > 0
JOIN rs_ref.dol_goods g ON lower(g.good) = lower(k.good) AND lower(g.country) = lower(TRIM(l.origin_country))
WHERE l.invoice_date >= ${sqlDate(from)}
ORDER BY l.line_id, k.good, g.exploitation_type`,

  /** Which listed-good categories each purchase line falls into, whatever its origin. */
  lineCategories: (from: string) => `
SELECT l.line_id, k.keyword, k.good
FROM rs_erp.purchase_lines l
JOIN rs_ref.good_keywords k ON instr(lower(l.description), k.keyword) > 0
WHERE l.invoice_date >= ${sqlDate(from)}
ORDER BY l.line_id, k.good`,

  /** Listings for goods proposed by the classifier for lines the taxonomy missed. */
  goodsForCountries: (goods: string[], countries: string[]) => `
SELECT g.country, g.good, g.exploitation_type, g.list_year, g.source_url
FROM rs_ref.dol_goods g
WHERE lower(g.good) IN (${litList(goods.map((x) => x.toLowerCase()))})
  AND lower(g.country) IN (${litList(countries.map((x) => x.toLowerCase()))})
ORDER BY g.country, g.good`,

  distinctGoods: () => `
SELECT DISTINCT g.good FROM rs_ref.dol_goods g ORDER BY g.good`,

  /** Supplier portal declarations x taxonomy x DOL list: components and inputs named in declarations. */
  declaredInputsScreen: () => `
SELECT d.decl_id, d.supplier_name, d.origin_countries, d.manufacturers, d.notes, k.keyword, k.good,
       g.country, g.exploitation_type, g.list_year, g.source_url
FROM rs_views.declarations d
JOIN rs_ref.good_keywords k
  ON instr(lower(concat(coalesce(d.manufacturers, ''), ' ', coalesce(d.notes, ''))), k.keyword) > 0
JOIN rs_ref.dol_goods g
  ON lower(g.good) = lower(k.good)
 AND instr(lower(concat(coalesce(d.origin_countries, ''), ' ', coalesce(d.manufacturers, ''), ' ', coalesce(d.notes, ''))), lower(g.country)) > 0
ORDER BY d.decl_id, k.good, g.exploitation_type`,

  /** ERP supplier categories and the company's own services x high-risk sector list. */
  sectorRisk: () => `
SELECT 'supplier' AS subject_type, s.supplier_id AS subject_id, s.name AS subject_name, s.category AS matched_text,
       r.keyword, r.sector, r.basis, r.source_url
FROM rs_erp.suppliers s
JOIN rs_ref.sector_risk r ON instr(lower(s.category), r.keyword) > 0
UNION ALL
SELECT 'own_operations' AS subject_type, p.item AS subject_id, 'Own operations' AS subject_name, p.detail AS matched_text,
       r.keyword, r.sector, r.basis, r.source_url
FROM rs_erp.company_profile p
JOIN rs_ref.sector_risk r ON instr(lower(p.detail), r.keyword) > 0
WHERE p.item = 'services'`,

  /**
   * Names to screen (built by the resolver from every system) x DFAT list.
   * Scores are 1 - levenshtein / max length, on normalized names and on
   * alphabetically sorted tokens; the better of the two counts. Returns the
   * three nearest listings per screened name plus anything above threshold.
   */
  sanctionsScreen: (names: { entityId: string; name: string; norm: string; sorted: string }[], threshold: number, nearMisses = 3) => {
    const rows = names
      .filter((x) => x.norm.length > 0)
      .map((x) => `SELECT ${lit(x.entityId)} AS entity_id, ${lit(x.name)} AS screened_name, ${lit(x.norm)} AS screened_norm, ${lit(x.sorted)} AS screened_sorted`)
      .join("\n  UNION ALL ");
    return `
WITH names AS (
  ${rows}
),
scored AS (
  SELECT n.entity_id, n.screened_name, d.list_id, d.name AS listed_name,
         GREATEST(
           1.0 - CAST(levenshtein(n.screened_norm, d.name_norm) AS DOUBLE) / GREATEST(length(n.screened_norm), length(d.name_norm)),
           1.0 - CAST(levenshtein(n.screened_sorted, d.name_sorted) AS DOUBLE) / GREATEST(length(n.screened_sorted), length(d.name_sorted))
         ) AS score
  FROM names n
  CROSS JOIN rs_ref.dfat_sanctions d
  WHERE length(d.name_norm) > 0
),
ranked AS (
  SELECT entity_id, screened_name, list_id, listed_name, score,
         ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY score DESC, list_id) AS rn
  FROM scored
),
kept AS (
  SELECT * FROM ranked WHERE rn <= ${sqlNumber(nearMisses)} OR score >= ${sqlNumber(threshold)}
)
-- Score and rank on names only, then join the wide columns back for the few rows kept.
-- Carrying them through the cross join and window crashed Spark on a Mini cluster.
SELECT k.entity_id, k.screened_name, k.list_id, k.listed_name, d.name_type, d.entity_type, d.citizenship, d.address,
       d.regime, d.listed_on, d.source, ROUND(k.score, 4) AS score, k.rn
FROM kept k
JOIN rs_ref.dfat_sanctions d ON d.list_id = k.list_id AND d.name = k.listed_name
ORDER BY k.entity_id, k.score DESC`;
  },

  sanctionsListSize: () => `
SELECT COUNT(*) AS listed_names, COUNT(DISTINCT d.list_id) AS listings FROM rs_ref.dfat_sanctions d`,

  /** Row counts per table, for the setup check and the sources panel. */
  tableCount: (ref: string) => `SELECT COUNT(*) AS row_count FROM ${ref}`,
};
