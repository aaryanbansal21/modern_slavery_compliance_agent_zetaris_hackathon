import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { runAssessment } from "../src/agents/orchestrator.ts";
import type { RunSummary } from "../src/agents/types.ts";
import { openWorld, recordApproval } from "../src/agents/world.ts";
import { prepareData } from "../src/data/prepare.ts";
import { writeOutputs } from "../src/reporting/outputs.ts";

let first: RunSummary;
const world = () => openWorld(config.agent.worldNamespace);

beforeAll(async () => {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  prepareData();
  first = await runAssessment({ world: world(), offlineAi: true, runId: "run-20261023-000001" });
});

describe("assessment loop, offline", () => {
  it("sends unsupported drafts back and fixes them with deeper federated checks", () => {
    expect(first.iterations).toBe(2);
    const q3 = first.answers.find((a) => a.question.id === "Q3")!;
    expect(q3.history[0].verdict).toBe("revise");
    expect(q3.history[0].requestedTools).toEqual(expect.arrayContaining(["line_origin_screen", "declared_inputs_screen"]));
    expect(q3.history[0].answer).toContain("We have not identified high-risk goods");
    expect(q3.status).toBe("approved");
    expect(q3.answer).toContain("Malaysia");
    const q4 = first.answers.find((a) => a.question.id === "Q4")!;
    expect(q4.history[0].issues.some((i) => i.gate === "evidence_sufficiency")).toBe(true);
    expect(first.coverage.sanctionsScope).toBe("extended");
  });

  it("builds an explainable risk register", () => {
    const level = (name: string) => first.supplierRisks.find((r) => r.name.startsWith(name))!.level;
    expect(level("CleanPro")).toBe("High");
    expect(level("SunCoast")).toBe("High");
    expect(level("SafeStep")).toBe("Medium");
    expect(level("NordicClean")).toBe("Medium");
    expect(level("Metro Fleet")).toBe("Not flagged");
    const nordic = first.supplierRisks.find((r) => r.name.startsWith("NordicClean"))!;
    expect(nordic.reasons.join(" ")).toMatch(/upstream/);
  });

  it("cites only evidence that exists, and every query is recorded", () => {
    const ids = new Set(first.evidence.map((e) => e.id));
    for (const a of first.answers) for (const c of a.citations) expect(ids.has(c)).toBe(true);
    expect(first.queries.every((q) => q.ok)).toBe(true);
    expect(first.queries.some((q) => q.systems.length >= 2)).toBe(true);
  });

  it("stops for a person where only a person can decide", () => {
    const types = first.escalations.map((e) => e.type).sort();
    expect(types).toEqual(["identity_review", "owner_approval"]);
    expect(first.answers.find((a) => a.question.id === "Q10")!.status).toBe("needs_sign_off");
  });

  it("writes the Word, Excel and evidence pack outputs", async () => {
    const files = await writeOutputs(first);
    for (const f of files) expect(fs.statSync(f).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(files[2], "utf8")).toContain("```sql");
  });

  it("remembers the person's decisions in the World Model on the next run", async () => {
    const w = world();
    const proposal = w.mergeQueue().find((m) => m.status === "pending")!;
    await w.approveMerge(proposal.id, "owner");
    await recordApproval(w, "notification_commitment", "We will notify Meridian Property Group within 10 business days if we identify modern slavery that relates to our services, and share our remediation plan.");
    const second = await runAssessment({ world: openWorld(config.agent.worldNamespace), offlineAi: true, runId: "run-20261023-000002" });
    expect(second.escalations.filter((e) => e.status === "open")).toHaveLength(0);
    expect(second.answers.every((a) => a.status === "approved")).toBe(true);
    expect(second.coverage.declarationsLinked).toBe(6);
    expect(fs.existsSync(path.join(config.dataDir, "runs", "run-20261023-000002", "trace.jsonl"))).toBe(true);
  });
});
