// Executor tools. Each runs federated queries through Zetaris, turns the rows
// into evidence (with the query IDs that produced it), and writes what it
// learned into the World Model for the other agents.
import { z } from "zod";
import { Q } from "../data/queries.ts";
import { b, n, s, type QueryRow } from "../data/source.ts";
import { readManifest } from "../data/prepare.ts";
import { companyKey, normalizeEntityName, sortedTokens } from "../util/names.ts";
import { capitalise, goodsPhrase, plainTypes, productName, shortName, sortTypes } from "../util/text.ts";
import { ADJUDICATOR_SYSTEM, CLASSIFIER_SYSTEM } from "./prompts.ts";
import {
  addEvidence, aud, listJoin, toolRan,
  type DeclarationInfo, type LineHit, type LineInfo, type RunContext, type SanctionAlert, type SupplierInfo,
} from "./context.ts";
import { linkDeclarationsDeterministic, resolveEntities } from "./resolver.ts";
import type { Evidence, Task, ToolName, Topic } from "./types.ts";
import { ids, prov, readApprovals, writeDeclaration, writeEvidence, writeLine, writeSupplier } from "./world.ts";

export interface ToolSpec {
  name: ToolName;
  tier: 1 | 2;
  description: string;
  params: string;
  topics: Topic[];
  dependsOn?: (params: Record<string, unknown>) => ToolName[];
}

export const TOOLS: ToolSpec[] = [
  {
    name: "profile_evidence", tier: 1, params: "{}",
    description: "Read the company's own policies, training, grievance mechanism, audits and board decisions from the ERP (rs_erp.company_profile), plus approvals recorded by the owner.",
    topics: ["policy", "training", "grievance", "due_diligence", "notification", "labour_and_subcontractors", "risks_and_actions"],
  },
  {
    name: "supplier_overview", tier: 1, params: "{}",
    description: "Supplier master and 12-month spend from the ERP, joined with the supplier portal declarations (REST). Links declarations to suppliers by ABN or email domain.",
    topics: ["due_diligence", "high_risk_goods", "labour_and_subcontractors", "risks_and_actions", "countries"],
  },
  {
    name: "origin_summary", tier: 1, params: "{}",
    description: "Spend by the country of origin recorded on invoice lines, including lines with no origin recorded.",
    topics: ["countries"],
  },
  {
    name: "sanctions_screen", tier: 1, params: `{"scope": "suppliers" | "extended", "threshold": number between 0.8 and 0.95}`,
    description: "Fuzzy-match names against the DFAT Consolidated List inside Zetaris. scope 'suppliers' screens supplier legal names only. scope 'extended' also screens parent companies, manufacturers and the names suppliers used in the portal (needs resolve_entities).",
    topics: ["sanctions", "due_diligence", "risks_and_actions"],
    dependsOn: (p) => (p.scope === "extended" ? ["resolve_entities"] : []),
  },
  {
    name: "sector_risk_check", tier: 1, params: "{}",
    description: "Match supplier categories and the company's own services against sectors recognised as high risk (labour hire, cleaning, construction, electronics, textiles).",
    topics: ["labour_and_subcontractors", "risks_and_actions", "high_risk_goods"],
  },
  {
    name: "resolve_entities", tier: 2, params: "{}",
    description: "Link records about the same company across the ERP and the supplier portal (ABN, email domain, name similarity) and build the manufacturer list in the World Model. Ambiguous links go to a human review queue.",
    topics: ["due_diligence", "sanctions"],
    dependsOn: () => ["supplier_overview"],
  },
  {
    name: "line_origin_screen", tier: 2, params: `{"classifyUnmatched": boolean}`,
    description: "Join every purchase line with the product taxonomy and the US DOL List of Goods on good and origin country, inside Zetaris. A classifier model maps lines the taxonomy misses.",
    topics: ["high_risk_goods", "countries", "risks_and_actions", "due_diligence"],
    dependsOn: () => ["supplier_overview", "resolve_entities"],
  },
  {
    name: "declared_inputs_screen", tier: 2, params: "{}",
    description: "Check components and inputs named in supplier declarations (for example battery cells or polysilicon) against the DOL list, to find upstream risks that invoice origins miss.",
    topics: ["high_risk_goods", "countries", "risks_and_actions"],
    dependsOn: () => ["resolve_entities", "line_origin_screen"],
  },
];

export const toolSpec = (name: string) => TOOLS.find((t) => t.name === name);

const dateOnly = (v: unknown) => s(v as string).slice(0, 10);

/** Manufacturer names for prose: resolved through the World Model where possible, one per company. */
export function makerNames(ctx: RunContext, raws: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const raw of raws) {
    if (!raw || /not specified|unspecified/i.test(raw)) continue;
    const resolved = ctx.state.manufacturers.find((m) => m.variants.includes(raw));
    const name = shortName(resolved?.name ?? raw);
    const key = resolved?.entityId ?? companyKey(raw);
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()];
}

async function record(ctx: RunContext, e: Parameters<typeof addEvidence>[1]): Promise<Evidence> {
  const ev = addEvidence(ctx, e);
  await writeEvidence(ctx, ev);
  return ev;
}

async function ensureLines(ctx: RunContext): Promise<LineInfo[]> {
  if (ctx.state.lines) return ctx.state.lines;
  const { rows, record: q } = await ctx.data.run("supplier_overview", "Purchase lines for the assessment period", Q.purchaseLines(ctx.state.periodFrom));
  ctx.state.lines = rows.map((r) => ({
    lineId: s(r.line_id), supplierId: s(r.supplier_id), supplierName: s(r.supplier_name), invoiceNo: s(r.invoice_no),
    invoiceDate: dateOnly(r.invoice_date), description: s(r.description), amountAud: n(r.amount_aud),
    originCountry: s(r.origin_country).trim(), manufacturer: s(r.manufacturer).trim(), manufacturerKey: s(r.manufacturer_key),
  }));
  for (const l of ctx.state.lines) await writeLine(ctx, l, q.id);
  return ctx.state.lines;
}

// ---------------------------------------------------------------- tier 1

async function profileEvidence(ctx: RunContext): Promise<string[]> {
  const { rows, record: q } = await ctx.data.run("profile_evidence", "Company policies, controls and registers", Q.companyProfile());
  const profile: Record<string, { detail: string; source: string; updatedAt: string }> = {};
  for (const r of rows) profile[s(r.item)] = { detail: s(r.detail).trim(), source: s(r.source), updatedAt: dateOnly(r.updated_at) };
  ctx.state.profile = profile;
  ctx.state.approvals = readApprovals(ctx.world);
  ctx.state.company = profile.legal_name?.detail || ctx.state.company;

  await ctx.world.upsertEntity({
    type: "organisation", externalKey: { system: "self", id: "company" }, name: ctx.state.company,
    attrs: { services: profile.services?.detail, workforce: profile.workforce?.detail, revenueBand: profile.revenue_band?.detail },
    source: prov(ctx, "zetaris", { ref: q.id, by: "executor" }),
  });

  const out: string[] = [];
  const item = async (key: string, title: string, topics: Topic[], present: (d: string) => string, missing: string) => {
    const p = profile[key];
    const has = !!p?.detail;
    const ev = await record(ctx, {
      tool: "profile_evidence", title, topics, queryIds: [q.id], supplierIds: [],
      statement: has ? present(p!.detail) : missing,
      data: { item: key, present: has, source: p?.source, updatedAt: p?.updatedAt },
    });
    out.push(ev.id);
  };
  await item("supplier_code_of_conduct", "Supplier Code of Conduct", ["policy", "due_diligence"], (d) => d, "No supplier code of conduct is recorded in the policy register.");
  await item("modern_slavery_policy", "Modern slavery policy", ["policy"], (d) => `Modern slavery policy: ${d}`, "The policy register has no standalone modern slavery policy.");
  await item("remediation_process", "Remediation process", ["policy", "risks_and_actions"], (d) => `Remediation process: ${d}`, "The policy register has no documented remediation process for cases of modern slavery.");
  await item("procurement_training", "Training", ["training"], (d) => d, "No modern slavery training is recorded in the training log.");
  await item("grievance_mechanism", "Grievance mechanism", ["grievance", "labour_and_subcontractors"], (d) => d, "No grievance or whistleblowing mechanism is recorded.");
  await item("third_party_audits", "Social audits", ["due_diligence"], (d) => d, "No record of third-party social audits.");
  await item("supplier_questionnaires", "Supplier declarations sent", ["due_diligence"], (d) => d, "No record of supplier questionnaires.");
  await item("workforce", "Workforce", ["labour_and_subcontractors"], (d) => d, "Workforce details are not recorded.");
  await item("services", "Services", ["labour_and_subcontractors", "risks_and_actions"], (d) => `Services: ${d}`, "Services are not recorded.");

  const approved = ctx.state.approvals.notification_commitment;
  const commitment = profile.client_notification_commitment?.detail;
  const ev = await record(ctx, {
    tool: "profile_evidence", title: "Client notification commitment", topics: ["notification"], queryIds: [q.id], supplierIds: [],
    statement: approved
      ? `The owner approved this commitment wording: "${approved}"`
      : commitment
        ? `Board decision log: ${commitment}`
        : "The board decision log has no decision on notifying clients about modern slavery in the supply chain.",
    data: { item: "client_notification_commitment", present: !!(approved || commitment), approvedByOwner: !!approved },
  });
  out.push(ev.id);
  return out;
}

async function supplierOverview(ctx: RunContext): Promise<string[]> {
  const sup = await ctx.data.run("supplier_overview", "Supplier master (ERP)", Q.suppliers());
  const spend = await ctx.data.run("supplier_overview", "Spend per supplier for the period (ERP)", Q.spendBySupplier(ctx.state.periodFrom));
  const decl = await ctx.data.run("supplier_overview", "Supplier declarations (REST portal via Zetaris view)", Q.declarations());
  const spendBy = new Map(spend.rows.map((r) => [s(r.supplier_id), r]));

  for (const r of sup.rows) {
    const sp = spendBy.get(s(r.supplier_id));
    const info: SupplierInfo = {
      supplierId: s(r.supplier_id), name: s(r.name), matchKey: s(r.match_key) || companyKey(s(r.name)), abn: s(r.abn),
      country: s(r.country), state: s(r.state), category: s(r.category), parentCompany: s(r.parent_company),
      emailDomain: s(r.email_domain), spendAud: n(sp?.spend_aud), lineCount: n(sp?.line_count),
      unknownOriginLines: n(sp?.unknown_origin_lines), entityId: ids.supplier(s(r.supplier_id)),
    };
    ctx.state.suppliers.set(info.supplierId, info);
    await writeSupplier(ctx, info, sup.record.id);
  }

  ctx.state.declarations = decl.rows.map((r: QueryRow): DeclarationInfo => ({
    declId: s(r.decl_id), supplierName: s(r.supplier_name), abn: s(r.abn).trim(), email: s(r.respondent_email).trim(),
    submittedAt: dateOnly(r.submitted_at), originCountries: s(r.origin_countries), manufacturers: s(r.manufacturers),
    hasCodeOfConduct: b(r.has_code_of_conduct), thirdPartyAudit: s(r.third_party_audit), recruitmentFeesPolicy: s(r.recruitment_fees_policy),
    notes: s(r.notes),
  }));
  for (const d of ctx.state.declarations) await writeDeclaration(ctx, d, decl.record.id);
  const linked = await linkDeclarationsDeterministic(ctx, decl.record.id);

  const suppliers = [...ctx.state.suppliers.values()];
  const total = suppliers.reduce((a, x) => a + x.spendAud, 0);
  const countries = [...new Set(suppliers.map((x) => x.country))];
  const out: string[] = [];
  out.push((await record(ctx, {
    tool: "supplier_overview", title: "Supplier base", topics: ["due_diligence", "high_risk_goods", "countries"],
    queryIds: [sup.record.id, spend.record.id], supplierIds: [],
    statement: `${suppliers.length} active suppliers, ${aud(total)} spend from ${ctx.state.periodFrom} to ${ctx.state.periodTo}. Supplier master country: ${listJoin(countries)} for all ${suppliers.length}.`,
    data: { suppliers: suppliers.length, spendAud: total, countries },
  })).id);

  const declaredIds = new Set(ctx.state.declarations.filter((d) => d.link).map((d) => d.link!.supplierId));
  const missing = suppliers.filter((x) => !declaredIds.has(x.supplierId));
  out.push((await record(ctx, {
    tool: "supplier_overview", title: "Supplier declarations", topics: ["due_diligence", "high_risk_goods"],
    queryIds: [decl.record.id], supplierIds: [...declaredIds],
    statement: `${ctx.state.declarations.length} supplier declarations received through the portal. ${linked} linked to a supplier record by ABN or email domain; ${ctx.state.declarations.length - linked} not yet linked. ${missing.length} suppliers (${aud(missing.reduce((a, x) => a + x.spendAud, 0))}) have no linked declaration: ${listJoin(missing.map((x) => x.name), 8)}. None of the declarations reports forced labour or child labour.`,
    data: { declarations: ctx.state.declarations.length, linked, missing: missing.map((x) => x.supplierId) },
  })).id);

  for (const x of suppliers.filter((v) => /labour hire|subcontract/i.test(v.category))) {
    const d = ctx.state.declarations.find((dd) => dd.link?.supplierId === x.supplierId);
    out.push((await record(ctx, {
      tool: "supplier_overview", title: `Labour hire: ${x.name}`, topics: ["labour_and_subcontractors", "due_diligence"],
      queryIds: [sup.record.id, spend.record.id, ...(d ? [decl.record.id] : [])], supplierIds: [x.supplierId],
      statement: `${x.name} supplies labour hire (${aud(x.spendAud)}, ${Math.round((x.spendAud / total) * 100)}% of spend, the largest supplier).${d ? ` Its declaration (${d.declId}) says: ${d.recruitmentFeesPolicy}. ${d.notes} Third-party audit: ${d.thirdPartyAudit}.` : " No declaration is linked."}`,
      data: { supplierId: x.supplierId, spendAud: x.spendAud, declId: d?.declId },
    })).id);
  }
  return out;
}

async function originSummary(ctx: RunContext): Promise<string[]> {
  const { rows, record: q } = await ctx.data.run("origin_summary", "Spend by recorded country of origin (ERP)", Q.originSummary(ctx.state.periodFrom));
  ctx.state.originSummary = rows.map((r) => ({ origin: s(r.origin), lineCount: n(r.line_count), spendAud: n(r.spend_aud) }));
  const lines = await ensureLines(ctx);
  const known = ctx.state.originSummary.filter((o) => o.origin !== "Unknown");
  const unknown = ctx.state.originSummary.find((o) => o.origin === "Unknown");
  const unknownLines = lines.filter((l) => !l.originCountry);
  const out: string[] = [];
  out.push((await record(ctx, {
    tool: "origin_summary", title: "Countries of origin on invoices", topics: ["countries"], queryIds: [q.id], supplierIds: [],
    statement: `Invoice lines record these countries of origin: ${known.map((o) => `${o.origin} (${aud(o.spendAud)}, ${o.lineCount} lines)`).join(", ")}.${unknown ? ` ${unknown.lineCount} lines (${aud(unknown.spendAud)}) have no origin recorded.` : ""}`,
    data: { origins: ctx.state.originSummary },
  })).id);
  if (unknownLines.length) {
    out.push((await record(ctx, {
      tool: "origin_summary", title: "Lines with no country of origin", topics: ["countries", "high_risk_goods", "due_diligence"],
      queryIds: [q.id, ...ctx.data.queries.filter((x) => x.purpose.startsWith("Purchase lines")).map((x) => x.id)],
      supplierIds: [...new Set(unknownLines.map((l) => l.supplierId))],
      statement: `No country of origin is recorded for: ${unknownLines.map((l) => `${l.description} from ${l.supplierName} (${l.invoiceNo}, ${aud(l.amountAud)})`).join("; ")}.`,
      data: { lineIds: unknownLines.map((l) => l.lineId) },
    })).id);
  }
  return out;
}

async function sectorRiskCheck(ctx: RunContext): Promise<string[]> {
  const { rows, record: q } = await ctx.data.run("sector_risk_check", "Suppliers and own operations x high-risk sectors (ERP + reference list)", Q.sectorRisk());
  const seen = new Set<string>();
  ctx.state.sectorHits = [];
  for (const r of rows) {
    const key = `${s(r.subject_id)}|${s(r.sector)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctx.state.sectorHits.push({
      subjectType: s(r.subject_type) as "supplier" | "own_operations", subjectId: s(r.subject_id), subjectName: s(r.subject_name),
      sector: s(r.sector), basis: s(r.basis), sourceUrl: s(r.source_url),
    });
  }
  const out: string[] = [];
  for (const h of ctx.state.sectorHits) {
    out.push((await record(ctx, {
      tool: "sector_risk_check", title: `Sector: ${h.sector}`, topics: ["labour_and_subcontractors", "risks_and_actions"],
      queryIds: [q.id], supplierIds: h.subjectType === "supplier" ? [h.subjectId] : [], sourceUrls: [h.sourceUrl],
      statement: h.subjectType === "own_operations"
        ? `Our own operations are in a high-risk sector: ${h.sector}. ${h.basis}`
        : `${h.subjectName} operates in a high-risk sector: ${h.sector}. ${h.basis}`,
      data: { ...h },
    })).id);
  }
  return out;
}

// ---------------------------------------------------------------- sanctions

const SanctionVerdict = z.object({ verdict: z.enum(["false_positive", "possible_match"]), reasons: z.array(z.string()).min(1) });

function adjudicatePolicy(alert: Omit<SanctionAlert, "verdict" | "reasons">, subject: { country?: string; abn?: string; role: string }): z.infer<typeof SanctionVerdict> {
  const reasons: string[] = [];
  const listedPlace = `${alert.citizenship} ${alert.address}`.toLowerCase();
  const subjectCountry = (subject.country ?? "").toLowerCase();
  if (alert.entityType && /individual|person/i.test(alert.entityType) && subject.role !== "person") {
    reasons.push(`The listing is for an individual; the screened party is a company.`);
  }
  if (subjectCountry && listedPlace.trim() && !listedPlace.includes(subjectCountry)) {
    reasons.push(`The listed entity is associated with ${alert.citizenship || alert.address}; the screened business is in ${subject.country}.`);
  }
  if (subject.abn) reasons.push(`The screened business has an Australian Business Number on file (${subject.abn}).`);
  if (alert.score < 0.95) reasons.push(`The names differ (similarity ${alert.score.toFixed(2)}).`);
  const conflicts = reasons.length >= 2;
  return conflicts
    ? { verdict: "false_positive", reasons }
    : { verdict: "possible_match", reasons: reasons.length ? reasons : ["Identifiers do not rule this out. A person should review it."] };
}

async function sanctionsScreen(ctx: RunContext, params: Record<string, unknown>): Promise<string[]> {
  const scope = params.scope === "extended" ? "extended" : "suppliers";
  const threshold = Math.min(0.95, Math.max(0.8, Number(params.threshold ?? 0.85) || 0.85));
  const manifest = readManifest();
  const listSource = ctx.data.mode === "zetaris" ? "DFAT Consolidated List (via Zetaris)" : manifest?.sanctions.source === "DFAT" ? "DFAT Consolidated List" : "TEST FIXTURE (synthetic names, not real sanctions data)";

  const names: { entityId: string; name: string; norm: string; sorted: string; role: string; country?: string; abn?: string }[] = [];
  for (const sp of ctx.state.suppliers.values()) {
    const norm = normalizeEntityName(sp.name);
    names.push({ entityId: sp.entityId, name: sp.name, norm, sorted: sortedTokens(norm), role: "supplier", country: sp.country, abn: sp.abn });
    if (scope === "extended" && sp.parentCompany) {
      const pn = normalizeEntityName(sp.parentCompany);
      names.push({ entityId: `${sp.entityId}#parent`, name: sp.parentCompany, norm: pn, sorted: sortedTokens(pn), role: "parent company" });
    }
  }
  if (scope === "extended") {
    for (const m of ctx.state.manufacturers) {
      const mn = normalizeEntityName(m.name);
      names.push({ entityId: m.entityId, name: m.name, norm: mn, sorted: sortedTokens(mn), role: "manufacturer", country: m.country });
    }
    for (const d of ctx.state.declarations) {
      const dn = normalizeEntityName(d.supplierName);
      if (!names.some((x) => x.norm === dn)) names.push({ entityId: ids.declaration(d.declId), name: d.supplierName, norm: dn, sorted: sortedTokens(dn), role: "name used in portal" });
    }
  }
  const uniq = [...new Map(names.filter((x) => x.norm).map((x) => [x.entityId, x])).values()];

  const size = await ctx.data.run("sanctions_screen", "Size of the sanctions list", Q.sanctionsListSize());
  const listNames = n(size.rows[0]?.listed_names);
  const { rows, record: q } = await ctx.data.run(
    "sanctions_screen",
    `Fuzzy-match ${uniq.length} names (${scope}) against the sanctions list at threshold ${threshold}`,
    Q.sanctionsScreen(uniq, threshold),
  );

  // Label the list from the data itself, so a test fixture can never be reported as the DFAT list.
  const sourcesSeen = [...new Set(rows.map((r) => s(r.source)).filter(Boolean))];
  const resolvedListSource = sourcesSeen.includes("TEST_FIXTURE")
    ? "TEST FIXTURE (synthetic names, not real sanctions data)"
    : sourcesSeen.includes("DFAT") ? "Australian Sanctions Consolidated List (DFAT)" : listSource;
  const nearest = new Map<string, { entityId: string; screenedName: string; listedName: string; score: number }>();
  const alertsRaw: Omit<SanctionAlert, "verdict" | "reasons">[] = [];
  for (const r of rows) {
    const score = n(r.score);
    const entityId = s(r.entity_id);
    if (!nearest.has(entityId) || nearest.get(entityId)!.score < score) {
      nearest.set(entityId, { entityId, screenedName: s(r.screened_name), listedName: s(r.listed_name), score });
    }
    if (score >= threshold && !alertsRaw.some((a) => a.entityId === entityId && a.listId === s(r.list_id))) {
      alertsRaw.push({
        entityId, screenedName: s(r.screened_name), listId: s(r.list_id), listedName: s(r.listed_name), entityType: s(r.entity_type),
        citizenship: s(r.citizenship), address: s(r.address), regime: s(r.regime), score,
      });
    }
  }

  const alerts: SanctionAlert[] = [];
  for (const a of alertsRaw) {
    const subject = uniq.find((x) => x.entityId === a.entityId)!;
    const { value } = await ctx.llm.json(
      "adjudicator",
      `Adjudicate sanctions alert: ${a.screenedName} ~ ${a.listedName}`,
      [
        { role: "system", content: ADJUDICATOR_SYSTEM },
        { role: "user", content: JSON.stringify({ screened: { name: subject.name, role: subject.role, country: subject.country ?? "unknown", abn: subject.abn ?? "" }, listed: { name: a.listedName, type: a.entityType, citizenship: a.citizenship, address: a.address, regime: a.regime }, similarity: a.score }) },
      ],
      SanctionVerdict,
      () => adjudicatePolicy(a, subject),
      { temperature: 0 },
    );
    alerts.push({ ...a, verdict: value.verdict, reasons: value.reasons });
    const listing = await ctx.world.upsertEntity({
      type: "listing", externalKey: { system: "dfat", id: a.listId }, name: a.listedName,
      attrs: { entityType: a.entityType, citizenship: a.citizenship, regime: a.regime }, source: prov(ctx, "zetaris", { ref: q.id }),
    });
    await ctx.world.relate({
      from: a.entityId.split("#")[0], type: "possible-match", to: listing.id,
      attrs: { score: a.score, verdict: value.verdict, reasons: value.reasons }, source: prov(ctx, "agent", { by: "adjudicator", ref: q.id }),
    });
  }

  ctx.state.sanctions = { scope, threshold, listSource: resolvedListSource, listNames, screened: uniq.map((x) => ({ entityId: x.entityId, name: x.name, role: x.role })), alerts, nearest: [...nearest.values()] };
  const out: string[] = [];
  const roles = [...new Set(uniq.map((x) => x.role))];
  const top = [...nearest.values()].sort((a, b) => b.score - a.score)[0];
  out.push((await record(ctx, {
    tool: "sanctions_screen", title: `Sanctions screening (${scope})`, topics: ["sanctions", "due_diligence"], queryIds: [size.record.id, q.id],
    supplierIds: [],
    statement: `Screened ${uniq.length} names (${roles.join(", ")}) against ${listNames.toLocaleString("en-AU")} names on the ${resolvedListSource}, using fuzzy matching at a ${threshold} similarity threshold. ${alertsRaw.length} name alerts at or above the threshold.${top ? ` Closest result: "${top.screenedName}" vs "${top.listedName}" (${top.score.toFixed(2)}).` : ""}`,
    data: { scope, threshold, screened: uniq.length, roles, listNames, alerts: alertsRaw.length, listSource: resolvedListSource },
  })).id);
  for (const a of alerts) {
    const ev = await record(ctx, {
      tool: "sanctions_screen", title: `Name alert: ${a.screenedName}`, topics: ["sanctions"], queryIds: [q.id],
      supplierIds: a.entityId.startsWith("supplier:erp:") ? [a.entityId.split(":")[2].split("#")[0]] : [],
      statement: `"${a.screenedName}" scored ${a.score.toFixed(2)} against listed entity "${a.listedName}" (${a.entityType || "type not stated"}, ${a.citizenship || a.address || "location not stated"}). Reviewed as ${a.verdict === "false_positive" ? "a false positive" : "a possible match that needs human and legal review"}: ${a.reasons.join(" ")}`,
      data: { ...a },
    });
    a.evidenceId = ev.id;
    out.push(ev.id);
  }
  return out;
}

// ---------------------------------------------------------------- tier 2

const ClassifierOut = z.object({
  classifications: z.array(z.object({
    line_id: z.string(), goods: z.array(z.string()), confidence: z.number().min(0).max(1), reason: z.string(),
  })),
});

async function lineOriginScreen(ctx: RunContext, params: Record<string, unknown>): Promise<string[]> {
  const lines = await ensureLines(ctx);
  const from = ctx.state.periodFrom;
  const screen = await ctx.data.run("line_origin_screen", "Purchase lines x product taxonomy x DOL List of Goods, matched on good and origin (ERP + object storage)", Q.lineOriginScreen(from));
  const cats = await ctx.data.run("line_origin_screen", "Listed-good categories for every purchase line (ERP + taxonomy)", Q.lineCategories(from));

  const hits = new Map<string, LineHit>();
  for (const r of screen.rows) {
    const key = `${s(r.line_id)}|${s(r.good)}|${s(r.exploitation_type)}`;
    if (!hits.has(key)) {
      hits.set(key, {
        lineId: s(r.line_id), supplierId: s(r.supplier_id), good: s(r.good), country: s(r.origin_country).trim(),
        exploitationType: s(r.exploitation_type), listYear: n(r.list_year), sourceUrl: s(r.source_url), via: "taxonomy", keyword: s(r.keyword),
      });
    }
  }
  ctx.state.lineCategories = new Map();
  for (const r of cats.rows) {
    const set = ctx.state.lineCategories.get(s(r.line_id)) ?? new Set<string>();
    set.add(s(r.good));
    ctx.state.lineCategories.set(s(r.line_id), set);
  }

  // Lines the taxonomy did not recognise go to the classifier model.
  const queryIds = [screen.record.id, cats.record.id];
  const unmatched = lines.filter((l) => !ctx.state.lineCategories.has(l.lineId));
  if (params.classifyUnmatched !== false && unmatched.length) {
    const goodsQ = await ctx.data.run("line_origin_screen", "Goods on the DOL list (allowed classifier labels)", Q.distinctGoods());
    const allowed = goodsQ.rows.map((r) => s(r.good));
    const { value } = await ctx.llm.json(
      "classifier",
      `Classify ${unmatched.length} purchase lines the taxonomy did not match`,
      [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: JSON.stringify({ allowedGoods: allowed, lines: unmatched.map((l) => ({ line_id: l.lineId, description: l.description })) }) },
      ],
      ClassifierOut,
      () => ({ classifications: [] }),
      { temperature: 0 },
    );
    const proposals = value.classifications
      .map((c) => ({ ...c, goods: c.goods.filter((g) => allowed.includes(g)) }))
      .filter((c) => c.goods.length && c.confidence >= 0.6 && unmatched.some((l) => l.lineId === c.line_id));
    if (proposals.length) {
      const goods = [...new Set(proposals.flatMap((p) => p.goods))];
      const countries = [...new Set(proposals.map((p) => lines.find((l) => l.lineId === p.line_id)?.originCountry).filter((x): x is string => !!x))];
      for (const p of proposals) {
        const set = ctx.state.lineCategories.get(p.line_id) ?? new Set<string>();
        p.goods.forEach((g) => set.add(g));
        ctx.state.lineCategories.set(p.line_id, set);
      }
      if (countries.length) {
        const extra = await ctx.data.run("line_origin_screen", `DOL listings for classifier-proposed goods (${goods.join(", ")})`, Q.goodsForCountries(goods, countries));
        queryIds.push(goodsQ.record.id, extra.record.id);
        for (const p of proposals) {
          const line = lines.find((l) => l.lineId === p.line_id)!;
          for (const r of extra.rows.filter((x) => p.goods.includes(s(x.good)) && s(x.country).toLowerCase() === line.originCountry.toLowerCase())) {
            const key = `${line.lineId}|${s(r.good)}|${s(r.exploitation_type)}`;
            if (!hits.has(key)) {
              hits.set(key, { lineId: line.lineId, supplierId: line.supplierId, good: s(r.good), country: line.originCountry, exploitationType: s(r.exploitation_type), listYear: n(r.list_year), sourceUrl: s(r.source_url), via: "classifier" });
            }
          }
        }
      }
    }
  }
  ctx.state.lineHits = [...hits.values()];

  // World Model: classification and listing edges.
  const source = prov(ctx, "zetaris", { ref: screen.record.id, by: "executor" });
  for (const [lineId, goods] of ctx.state.lineCategories) {
    for (const g of goods) {
      const good = await ctx.world.upsertEntity({ type: "good", name: g, source });
      await ctx.world.relate({ from: ids.line(lineId), type: "classified-as", to: good.id, source });
    }
  }
  for (const h of ctx.state.lineHits) {
    const country = await ctx.world.upsertEntity({ type: "country", name: h.country, source });
    await ctx.world.relate({ from: ids.good(h.good), type: "listed-for", to: country.id, attrs: { exploitationType: h.exploitationType, listYear: h.listYear, sourceUrl: h.sourceUrl }, source });
  }

  // Evidence: one item per supplier and origin country.
  const out: string[] = [];
  const groups = new Map<string, LineHit[]>();
  for (const h of ctx.state.lineHits) {
    const key = `${h.supplierId}|${h.country}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const hs of groups.values()) {
    const { supplierId, country } = hs[0];
    const sup = ctx.state.suppliers.get(supplierId);
    const lineIds = [...new Set(hs.map((h) => h.lineId))];
    const ls = lineIds.map((id) => lines.find((l) => l.lineId === id)!).filter(Boolean);
    const spend = ls.reduce((a, l) => a + l.amountAud, 0);
    const goods = [...new Set(hs.map((h) => h.good))];
    const types = sortTypes(hs.map((h) => h.exploitationType));
    const makers = makerNames(ctx, ls.map((l) => l.manufacturer));
    const products = [...new Set(ls.map((l) => productName(l.description)))];
    const viaClassifier = hs.some((h) => h.via === "classifier");
    const gp = goodsPhrase(goods);
    out.push((await record(ctx, {
      tool: "line_origin_screen", title: `${capitalise(listJoin(products, 3))} from ${country}: ${shortName(sup?.name ?? supplierId)}`,
      topics: ["high_risk_goods", "risks_and_actions", "countries"], queryIds, supplierIds: [supplierId],
      sourceUrls: [...new Set(hs.map((h) => h.sourceUrl))],
      statement: `${ls.length} invoice line${ls.length > 1 ? "s" : ""} from ${sup?.name ?? supplierId} (${ls.map((l) => l.invoiceNo).join(", ")}; ${aud(spend)}): ${listJoin(products, 4)}, made in ${country}${makers.length ? ` by ${listJoin(makers, 2)}` : ""}. ${capitalise(gp.text)} from ${country} ${gp.verb} on the US DOL List of Goods for ${listJoin(plainTypes(types))} (${hs[0].listYear} edition).${viaClassifier ? " The category was assigned by the classifier model, so a person should confirm it." : ""}`,
      data: { supplierId, goods, products, country, exploitationTypes: types, lineIds, spendAud: spend, viaClassifier, makers },
    })).id);
  }

  const withOrigin = lines.filter((l) => l.originCountry);
  const totalSpend = lines.reduce((a, l) => a + l.amountAud, 0);
  const hitLines = new Set(ctx.state.lineHits.map((h) => h.lineId));
  const riskyUnknown = lines.filter((l) => !l.originCountry && ctx.state.lineCategories.has(l.lineId));
  out.unshift((await record(ctx, {
    tool: "line_origin_screen", title: "Line-level screen coverage", topics: ["high_risk_goods", "countries", "due_diligence", "risks_and_actions"],
    queryIds, supplierIds: [],
    statement: `Screened all ${lines.length} purchase lines (${aud(totalSpend)}) against the US DOL List of Goods by product and country of origin. ${withOrigin.length} lines (${aud(withOrigin.reduce((a, l) => a + l.amountAud, 0))}) have an origin recorded. ${hitLines.size} lines from ${new Set(ctx.state.lineHits.map((h) => h.supplierId)).size} suppliers (${aud(lines.filter((l) => hitLines.has(l.lineId)).reduce((a, l) => a + l.amountAud, 0))}) are listed goods from a listed country.${riskyUnknown.length ? ` ${riskyUnknown.length} lines in a listed category have no origin recorded.` : " No line in a listed category is missing its origin."}`,
    data: { lines: lines.length, withOrigin: withOrigin.length, hitLines: hitLines.size, riskyUnknown: riskyUnknown.map((l) => l.lineId) },
  })).id);
  return out;
}

async function declaredInputsScreen(ctx: RunContext): Promise<string[]> {
  const { rows, record: q } = await ctx.data.run("declared_inputs_screen", "Inputs named in supplier declarations x taxonomy x DOL List of Goods (REST portal + object storage)", Q.declaredInputsScreen());
  const lines = await ensureLines(ctx);
  const seen = new Set<string>();
  ctx.state.declaredInputHits = [];
  const affectedBy = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${s(r.decl_id)}|${s(r.good)}|${s(r.country)}|${s(r.exploitation_type)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const decl = ctx.state.declarations.find((d) => d.declId === s(r.decl_id));
    const supplierId = decl?.link?.supplierId;
    const good = s(r.good);
    const country = s(r.country).toLowerCase();
    // Lines from this supplier in the same goods category.
    const inCategory = lines.filter((l) => l.supplierId === supplierId && ctx.state.lineCategories.get(l.lineId)?.has(good));
    const flagged = new Set(ctx.state.lineHits.map((h) => h.lineId));
    // A declared input adds information when it applies to lines that the
    // invoice screen did not flag, for example China battery cells inside
    // equipment the invoice says was made in Germany.
    const affected = inCategory.filter((l) => l.originCountry.toLowerCase() !== country && !flagged.has(l.lineId));
    const corroborates = !affected.length && inCategory.some((l) => l.originCountry.toLowerCase() === country);
    if (affected.length) affectedBy.set(`${s(r.decl_id)}|${good}|${s(r.country)}`, affected.map((l) => l.lineId));
    ctx.state.declaredInputHits.push({
      declId: s(r.decl_id), supplierId, good, country: s(r.country), exploitationType: s(r.exploitation_type),
      keyword: s(r.keyword), sourceUrl: s(r.source_url), corroboratesInvoices: corroborates,
    });
  }
  const out: string[] = [];
  const byDecl = new Map<string, typeof ctx.state.declaredInputHits>();
  for (const h of ctx.state.declaredInputHits) byDecl.set(h.declId, [...(byDecl.get(h.declId) ?? []), h]);
  for (const [declId, hs] of byDecl) {
    const decl = ctx.state.declarations.find((d) => d.declId === declId)!;
    const sup = hs[0].supplierId ? ctx.state.suppliers.get(hs[0].supplierId) : undefined;
    const fresh = hs.filter((h) => !h.corroboratesInvoices);
    const confirmedLink = decl.link?.confirmed ?? false;
    const pairs = [...new Set(hs.map((h) => `${h.good} from ${h.country}`))];
    const types = [...new Set(hs.map((h) => h.exploitationType))];
    const newPairs = [...new Set(fresh.map((h) => `${h.good} from ${h.country}`))];
    if (sup) {
      const source = prov(ctx, "zetaris", { ref: q.id, by: "executor" });
      for (const h of hs) await ctx.world.relate({ from: ids.declaration(declId), type: "declares-input", to: ids.good(h.good), attrs: { country: h.country, exploitationType: h.exploitationType }, source });
    }
    const affectedLines = [...new Set(fresh.flatMap((h) => affectedBy.get(`${declId}|${h.good}|${h.country}`) ?? []))]
      .map((id) => lines.find((l) => l.lineId === id)!).filter(Boolean);
    const quote = [decl.manufacturers, decl.notes].filter(Boolean).join(". ").replace(/\.\./g, ".");
    out.push((await record(ctx, {
      tool: "declared_inputs_screen",
      title: fresh.length ? `Upstream input: ${shortName(sup?.name ?? decl.supplierName)}` : `Declaration matches invoices: ${shortName(sup?.name ?? decl.supplierName)}`,
      topics: fresh.length ? ["high_risk_goods", "countries", "risks_and_actions"] : ["high_risk_goods", "due_diligence"],
      queryIds: [q.id], supplierIds: sup ? [sup.supplierId] : [], provisional: !!decl.link && !confirmedLink,
      sourceUrls: [...new Set(hs.map((h) => h.sourceUrl))],
      statement: fresh.length
        ? `Declaration ${declId} from ${decl.supplierName} says: "${quote}".${affectedLines.length ? ` Our invoices record ${listJoin(affectedLines.map((l) => `${productName(l.description)} (${l.invoiceNo})`))} as made in ${listJoin([...new Set(affectedLines.map((l) => l.originCountry))])}, so` : " So"} ${listJoin(newPairs)} ${newPairs.length > 1 ? "are inputs" : "is an input"} that the invoice data does not show. ${listJoin(newPairs)} ${newPairs.length > 1 ? "are" : "is"} on the US DOL List of Goods for ${listJoin(plainTypes(fresh.map((h) => h.exploitationType)))}.`
        : `Declaration ${declId} from ${decl.supplierName} is consistent with the invoice data (${listJoin(pairs)}). Audit: ${decl.thirdPartyAudit}.`,
      data: { declId, supplierId: sup?.supplierId, newPairs, pairs, types, affectedLineIds: affectedLines.map((l) => l.lineId) },
    })).id);
  }
  if (!byDecl.size) {
    out.push((await record(ctx, {
      tool: "declared_inputs_screen", title: "Declared inputs", topics: ["high_risk_goods"], queryIds: [q.id], supplierIds: [],
      statement: `None of the ${ctx.state.declarations.length} declarations names an input on the DOL list.`,
    })).id);
  }
  void lines;
  return out;
}

// ---------------------------------------------------------------- dispatcher

export async function runTool(ctx: RunContext, task: Task): Promise<{ evidenceIds: string[]; summary: string }> {
  const t0 = performance.now();
  let evidenceIds: string[] = [];
  switch (task.tool) {
    case "profile_evidence": evidenceIds = await profileEvidence(ctx); break;
    case "supplier_overview": evidenceIds = await supplierOverview(ctx); break;
    case "origin_summary": evidenceIds = await originSummary(ctx); break;
    case "sanctions_screen": evidenceIds = await sanctionsScreen(ctx, task.params); break;
    case "sector_risk_check": evidenceIds = await sectorRiskCheck(ctx); break;
    case "resolve_entities": evidenceIds = await resolveEntities(ctx, ensureLines, record); break;
    case "line_origin_screen": evidenceIds = await lineOriginScreen(ctx, task.params); break;
    case "declared_inputs_screen": evidenceIds = await declaredInputsScreen(ctx); break;
  }
  const ms = Math.round(performance.now() - t0);
  const summary = evidenceIds.map((id) => ctx.state.evidence.find((e) => e.id === id)?.statement ?? "").join(" ").slice(0, 600);
  ctx.state.toolsRun.push({ tool: task.tool, params: task.params, iteration: ctx.trace.iteration, evidenceIds, summary, ms });
  return { evidenceIds, summary };
}

export function alreadyRan(ctx: RunContext, task: Task): boolean {
  return toolRan(ctx, task.tool, (p) => JSON.stringify(normalizeParams(task.tool, p)) === JSON.stringify(normalizeParams(task.tool, task.params)));
}

export function normalizeParams(tool: ToolName, params: Record<string, unknown>): Record<string, unknown> {
  if (tool === "sanctions_screen") return { scope: params.scope === "extended" ? "extended" : "suppliers", threshold: Math.min(0.95, Math.max(0.8, Number(params.threshold ?? 0.85) || 0.85)) };
  if (tool === "line_origin_screen") return { classifyUnmatched: params.classifyUnmatched !== false };
  return {};
}
