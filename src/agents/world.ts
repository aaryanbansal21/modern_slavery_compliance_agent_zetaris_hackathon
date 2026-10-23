// Domain integration with the World Model. Agents share state through it:
// suppliers, lines, manufacturers, countries, goods, declarations, evidence,
// findings, risk levels and answers, each with provenance that points back to
// the run, the iteration and the Zetaris query that produced it. It persists
// across runs, so the next assessment starts from what the last one learned,
// including identity links a person approved.
import path from "node:path";
import { config } from "../config.ts";
import { entityIdFromName, externalId, WorldModel, type Provenance } from "../engines/world-model/index.ts";
import { companyKey } from "../util/names.ts";
import type { DeclarationInfo, LineInfo, RunContext, SupplierInfo } from "./context.ts";
import type { Evidence, Finding, SupplierRisk } from "./types.ts";

export const MULTI_VALUED = [
  "mentions", "supplies", "classified-as", "listed-for", "supports", "about", "cites", "possible-match", "screened-against", "declares-input",
];

export function openWorld(namespace = config.agent.worldNamespace, storage: "file" | "memory" = "file"): WorldModel {
  return new WorldModel({
    namespace,
    storage,
    directory: path.join(config.dataDir, "world"),
    conflictPolicy: "most-recent-wins",
    multiValued: MULTI_VALUED,
  });
}

export const ids = {
  org: () => externalId("organisation", "self", "company"),
  supplier: (supplierId: string) => externalId("supplier", "erp", supplierId),
  line: (lineId: string) => externalId("line", "erp", lineId),
  declaration: (declId: string) => externalId("declaration", "portal", declId),
  country: (name: string) => entityIdFromName("country", name),
  good: (name: string) => entityIdFromName("good", name),
  manufacturer: (name: string) => entityIdFromName("manufacturer", companyKey(name)),
  listing: (listId: string) => externalId("listing", "dfat", listId),
  evidence: (runId: string, id: string) => externalId("evidence", runId, id),
  finding: (runId: string, id: string) => externalId("finding", runId, id),
  question: (qid: string) => externalId("question", "questionnaire", qid),
};

export function prov(ctx: RunContext, kind: string, extra: Partial<Provenance> = {}): Provenance {
  return { kind, at: ctx.now(), runId: ctx.state.runId, ...extra };
}

export async function writeSupplier(ctx: RunContext, s: SupplierInfo, queryId: string) {
  await ctx.world.upsertEntity({
    type: "supplier",
    externalKey: { system: "erp", id: s.supplierId },
    name: s.name,
    matchKey: s.matchKey,
    attrs: { abn: s.abn, country: s.country, state: s.state, category: s.category, parentCompany: s.parentCompany || undefined, emailDomain: s.emailDomain, spendAud: s.spendAud },
    source: prov(ctx, "zetaris", { ref: queryId, by: "executor" }),
  });
}

export async function writeLine(ctx: RunContext, l: LineInfo, queryId: string) {
  const source = prov(ctx, "zetaris", { ref: queryId, by: "executor" });
  const line = await ctx.world.upsertEntity({
    type: "line",
    externalKey: { system: "erp", id: l.lineId },
    name: l.description,
    attrs: { invoiceNo: l.invoiceNo, invoiceDate: l.invoiceDate, amountAud: l.amountAud, originCountry: l.originCountry || undefined, manufacturer: l.manufacturer || undefined },
    source,
  });
  await ctx.world.relate({ from: ids.supplier(l.supplierId), type: "supplies", to: line.id, source, validFrom: `${l.invoiceDate}T00:00:00.000Z` });
  if (l.originCountry) {
    const country = await ctx.world.upsertEntity({ type: "country", name: l.originCountry, source });
    await ctx.world.relate({ from: line.id, type: "originates-in", to: country.id, source, validFrom: `${l.invoiceDate}T00:00:00.000Z` });
  }
}

export async function writeDeclaration(ctx: RunContext, d: DeclarationInfo, queryId: string) {
  await ctx.world.upsertEntity({
    type: "declaration",
    externalKey: { system: "portal", id: d.declId },
    name: `${d.declId} ${d.supplierName}`,
    attrs: {
      supplierName: d.supplierName, abn: d.abn || undefined, email: d.email || undefined, submittedAt: d.submittedAt,
      originCountries: d.originCountries, manufacturers: d.manufacturers, hasCodeOfConduct: d.hasCodeOfConduct,
      thirdPartyAudit: d.thirdPartyAudit, recruitmentFeesPolicy: d.recruitmentFeesPolicy, notes: d.notes,
    },
    source: prov(ctx, "zetaris", { ref: queryId, by: "executor" }),
  });
}

export async function writeEvidence(ctx: RunContext, e: Evidence) {
  const source = prov(ctx, "agent", { by: e.tool, ref: e.queryIds.join(",") || undefined });
  const ent = await ctx.world.upsertEntity({
    type: "evidence",
    externalKey: { system: ctx.state.runId, id: e.id },
    name: `${e.id} ${e.title}`,
    attrs: { statement: e.statement, queryIds: e.queryIds, tables: e.tables, systems: e.systems, iteration: e.iteration, provisional: e.provisional || undefined },
    source,
  });
  for (const sid of e.supplierIds) {
    await ctx.world.relate({ from: ent.id, type: "supports", to: ids.supplier(sid), source });
  }
}

export async function writeFinding(ctx: RunContext, f: Finding) {
  const source = prov(ctx, "agent", { by: "risk" });
  const ent = await ctx.world.upsertEntity({
    type: "finding",
    externalKey: { system: ctx.state.runId, id: f.id },
    name: f.title,
    attrs: { findingType: f.type, severity: f.severity, detail: f.detail, spendAud: f.spendAud, lineIds: f.lineIds },
    source,
  });
  if (f.supplierId) await ctx.world.relate({ from: ent.id, type: "about", to: ids.supplier(f.supplierId), source });
  for (const eid of f.evidenceIds) await ctx.world.relate({ from: ent.id, type: "cites", to: ids.evidence(ctx.state.runId, eid), source });
}

/** Risk level as a fact. Earlier levels are superseded, not deleted, so the history shows how the assessment changed. */
export async function writeRisk(ctx: RunContext, r: SupplierRisk) {
  await ctx.world.assertFact({
    about: ids.supplier(r.supplierId),
    predicate: "risk_level",
    value: { level: r.level, score: r.score, reasons: r.reasons, iteration: ctx.trace.iteration },
    confidence: r.level === "Not flagged" ? 0.5 : 0.8,
    source: prov(ctx, "agent", { by: "risk", ref: `iteration-${ctx.trace.iteration}` }),
  });
}

export async function writeAnswer(ctx: RunContext, questionId: string, answer: string, verdict: string) {
  await ctx.world.assertFact({
    about: ids.question(questionId),
    predicate: "answer",
    value: { answer, verdict, iteration: ctx.trace.iteration },
    confidence: verdict === "approve" ? 0.9 : 0.5,
    source: prov(ctx, "agent", { by: "drafter", ref: `iteration-${ctx.trace.iteration}` }),
  });
}

/** Approvals made by a person in the UI (wording sign-off) live in the World Model too. */
export function readApprovals(world: WorldModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of world.view("facts").about(ids.org())) {
    if (f.predicate.startsWith("approved:") && !f.supersededBy && typeof f.value === "string") out[f.predicate.slice(9)] = f.value;
  }
  return out;
}

export async function recordApproval(world: WorldModel, key: string, wording: string, by = "owner") {
  await world.upsertEntity({ type: "organisation", externalKey: { system: "self", id: "company" }, name: "Company", source: { kind: "owner", at: new Date(), by } });
  await world.assertFact({ about: ids.org(), predicate: `approved:${key}`, value: wording, confidence: 1, source: { kind: "owner", at: new Date(), by } });
}
