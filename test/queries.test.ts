import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDuckDbSource } from "../src/data/local.ts";
import { buildDir, prepareData } from "../src/data/prepare.ts";
import { Q } from "../src/data/queries.ts";
import { lit } from "../src/data/source.ts";
import { tablesInSql } from "../src/data/schema.ts";

let db: LocalDuckDbSource;
beforeAll(async () => {
  prepareData();
  db = await LocalDuckDbSource.open(buildDir());
});
afterAll(async () => db.close());

describe("federated query library (offline stand-in)", () => {
  it("joins purchase lines, the product taxonomy and the DOL list across sources", async () => {
    const sql = Q.lineOriginScreen("2025-10-24");
    expect(tablesInSql(sql)).toEqual(["rs_erp.purchase_lines", "rs_erp.suppliers", "rs_ref.dol_goods", "rs_ref.good_keywords"]);
    const { rows } = await db.query(sql);
    const gloves = rows.find((r) => r.line_id === "L0001" && r.good === "Rubber Gloves");
    expect(gloves?.origin_country).toBe("Malaysia");
    expect(gloves?.exploitation_type).toBe("Forced Labor");
    expect(rows.some((r) => r.line_id === "L0023")).toBe(false); // German scrubber: not a listed country
  });

  it("finds upstream inputs named in supplier declarations", async () => {
    const { rows } = await db.query(Q.declaredInputsScreen());
    expect(rows.some((r) => r.decl_id === "D-004" && r.good === "Lithium-Ion Batteries" && r.country === "China")).toBe(true);
  });

  it("fuzzy-matches names against the sanctions list inside the database", async () => {
    const { rows } = await db.query(Q.sanctionsScreen([{ entityId: "x", name: "Pacific Star Trading Pty Ltd", norm: "pacific star trading", sorted: "pacific star trading" }], 0.85));
    expect(rows[0].listed_name).toBe("PACIFIC STAR TRADING COMPANY LIMITED");
    expect(Number(rows[0].score)).toBe(1);
  });

  it("strips characters that escape differently in Spark SQL and DuckDB", () => {
    expect(lit("O'Brien \\ Co")).toBe("'OBrien  Co'");
  });
});
