import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/engines/world-model/index.ts";

const src = (at: string) => ({ kind: "test", at });

describe("World Model engine", () => {
  it("passes the official Meterless conformance suite", () => {
    const out = execFileSync("npx", ["tsx", "test/conformance/world-model-runner.ts"], { encoding: "utf8" });
    expect(out).toContain("8/8 checks passed");
  });

  it("auto-merges near-duplicate names and queues review-band names for a person", async () => {
    const w = new WorldModel({ namespace: "t1" });
    await w.upsertEntity({ type: "supplier", externalKey: { system: "erp", id: "S1" }, name: "CleanPro Supplies Pty Ltd", matchKey: "cleanpro supplies", source: src("2026-01-01") });
    const review = await w.upsertEntityResolved({ type: "supplier", name: "Cleanpro Supply Co", matchKey: "cleanpro supply", source: src("2026-02-01") });
    expect(review.decision).toBe("review");
    expect(w.mergeQueue()).toHaveLength(1);
    const merge = await w.upsertEntityResolved({ type: "supplier", name: "CleanPro Supplies", matchKey: "cleanpro supplie", source: src("2026-02-02") });
    expect(merge.decision).toBe("auto-merge");
    expect(w.resolveId(merge.entity.id)).toBe("supplier:erp:S1");
    await w.approveMerge(w.mergeQueue()[0].id, "owner");
    expect(w.resolveId(review.entity.id)).toBe("supplier:erp:S1");
    expect(w.entity("supplier:erp:S1")!.aliases).toContain("Cleanpro Supply Co");
  });

  it("keeps superseded facts so the history shows how an assessment changed", async () => {
    const w = new WorldModel({ namespace: "t2" });
    await w.assertFact({ about: "supplier:erp:S1", predicate: "risk_level", value: "Low", source: src("2026-10-23T01:00:00Z") });
    await w.assertFact({ about: "supplier:erp:S1", predicate: "risk_level", value: "High", source: src("2026-10-23T01:05:00Z") });
    const facts = w.view("facts").about("supplier:erp:S1", "risk_level");
    expect(facts.map((f) => f.value)).toEqual(["Low", "High"]);
    expect(facts[0].supersededBy).toBe(facts[1].id);
    expect(w.currentFact("supplier:erp:S1", "risk_level")!.value).toBe("High");
  });

  it("rebuilds every view from the event log with the same result", async () => {
    const w = new WorldModel({ namespace: "t3", multiValued: ["supplies"] });
    await w.upsertEntity({ type: "supplier", externalKey: { system: "erp", id: "S1" }, name: "A", source: src("2026-01-01") });
    await w.upsertEntity({ type: "line", externalKey: { system: "erp", id: "L1" }, name: "gloves", source: src("2026-01-01") });
    await w.relate({ from: "supplier:erp:S1", type: "supplies", to: "line:erp:L1", source: src("2026-01-01") });
    expect(w.verifyReplay().ok).toBe(true);
  });

  it("treats re-asserting an unchanged record as a no-op", async () => {
    const w = new WorldModel({ namespace: "t4" });
    const input = { type: "supplier", externalKey: { system: "erp", id: "S1" }, name: "A", attrs: { abn: "1" }, source: src("2026-01-01") };
    await w.upsertEntity(input);
    const events = w.events().length;
    await w.upsertEntity({ ...input, source: src("2026-03-01") });
    expect(w.events().length).toBe(events);
  });
});
