// Risk scorer. Deterministic and explainable on purpose: every point in a
// supplier's score comes from a named rule and cites evidence.
//
//   Listed good from a listed country (US DOL List of Goods)
//     Forced Labor / Forced Child Labor ............ 3.0
//     Child Labor ................................... 2.5
//     Inputs Produced with Forced Labor ............. 2.0
//     Inputs Produced with Child Labor .............. 1.75
//   Input named in a declaration, not on invoices ... rule above minus 0.25
//   High-risk sector: labour hire 2.25, construction 1.5, other 1.25
//   Sanctions name alert not cleared ................ 3.0
//   Origin not recorded for some lines .............. 0.5
//   Mitigation: third-party social audit provided ... minus 0.5
//
//   High >= 2.75, Medium >= 1.75, Low > 0, otherwise Not flagged.
// These are inherent risks of the goods, countries and sectors involved, not
// findings that forced labour occurred at a supplier.
import { aud, listJoin, type RunContext } from "./context.ts";
import { goodsPhrase, pairText, plainTypes, productName, shortName } from "../util/text.ts";
import { makerNames } from "./tools.ts";
import type { Action, Finding, Severity, SupplierRisk, Topic } from "./types.ts";
import { writeRisk } from "./world.ts";

const LISTING_SCORE: Record<string, number> = {
  "Forced Labor": 3, "Forced Child Labor": 3, "Child Labor": 2.5,
  "Inputs Produced with Forced Labor": 2, "Inputs Produced with Child Labor": 1.75,
};

const severityOf = (score: number): Severity => (score >= 2.75 ? "high" : score >= 1.75 ? "medium" : score > 0 ? "low" : "info");
const levelOf = (score: number): SupplierRisk["level"] => (score >= 2.75 ? "High" : score >= 1.75 ? "Medium" : score > 0 ? "Low" : "Not flagged");
const lc = (s: string) => s.toLowerCase();

const GOOD_ACTIONS: { match: RegExp; title: (sup: string, makers: string) => string; text: (sup: string, makers: string) => string }[] = [
  {
    match: /electronics/i,
    title: (sup) => `Check device brands with ${sup}`,
    text: (sup) => `Ask ${sup} for the brand and model of each device, then check each brand's statement on the Modern Slavery Statements Register before the next purchase.`,
  },
  {
    match: /solar|polysilicon|photovoltaic/i,
    title: (sup) => `Get solar module traceability from ${sup}`,
    text: (sup) => `Ask ${sup} for the module brand and polysilicon traceability documents. Make traceability a condition of future solar purchases.`,
  },
  {
    match: /gloves/i,
    title: (sup, makers) => `Get social audit evidence for ${makers || "the glove factory"}`,
    text: (sup, makers) => `Ask ${sup} for a recent third-party social audit of ${makers || "the glove factory"}, its policy on recruitment fees paid by workers, and evidence of corrective actions. Consider an alternative source if no evidence arrives within 60 days.`,
  },
  {
    match: /garments|textiles|cotton|thread/i,
    title: (sup) => `Get factory and audit details from ${sup}`,
    text: (sup, makers) => `Ask ${sup} for the factory details${makers ? ` for ${makers}` : ""}, a recent third-party social audit (for example SMETA or amfori BSCI) and the origin of the cotton or yarn. Agree a corrective plan if gaps are found.`,
  },
  {
    match: /lithium/i,
    title: (sup) => `Trace battery cell suppliers with ${sup}`,
    text: (sup) => `Ask ${sup} to name its battery cell suppliers and their countries, and to share its group supplier audit results.`,
  },
];

export async function scoreRisks(ctx: RunContext): Promise<void> {
  const st = ctx.state;
  const lines = st.lines ?? [];
  const findings: Finding[] = [];
  const actions: Action[] = [];
  const risks: SupplierRisk[] = [];
  const ev = (pred: (e: (typeof st.evidence)[number]) => boolean) => st.evidence.filter(pred).map((e) => e.id);
  let fSeq = 0;
  let aSeq = 0;
  const finding = (f: Omit<Finding, "id">) => {
    const full = { ...f, id: `F-${++fSeq}` };
    findings.push(full);
    return full;
  };
  const action = (a: Omit<Action, "id">) => actions.push({ ...a, id: `A-${++aSeq}` });

  for (const sup of st.suppliers.values()) {
    let score = 0;
    const reasons: string[] = [];
    const mitigations: string[] = [];
    const fIds: string[] = [];
    const supEvidence = new Set<string>();
    const decl = st.declarations.find((d) => d.link?.supplierId === sup.supplierId);

    // Listed goods on invoices.
    const hits = st.lineHits.filter((h) => h.supplierId === sup.supplierId);
    const short = shortName(sup.name);
    if (hits.length) {
      const top = Math.max(...hits.map((h) => LISTING_SCORE[h.exploitationType] ?? 1.5));
      score = Math.max(score, top);
      const lineIds = [...new Set(hits.map((h) => h.lineId))];
      const supLines = lines.filter((l) => lineIds.includes(l.lineId));
      const spend = supLines.reduce((a, l) => a + l.amountAud, 0);
      const types = [...new Set(hits.map((h) => h.exploitationType))];
      const byCountry = [...new Set(hits.map((h) => h.country))].map((c) => {
        const ls = supLines.filter((l) => l.originCountry === c);
        return `${listJoin([...new Set(ls.map((l) => productName(l.description)))], 3)} from ${c}`;
      });
      const eIds = ev((e) => e.tool === "line_origin_screen" && e.supplierIds.includes(sup.supplierId));
      eIds.forEach((id) => supEvidence.add(id));
      reasons.push(`${listJoin(byCountry)}: listed goods (${listJoin(plainTypes(types))}), ${aud(spend)}`);
      const makers = makerNames(ctx, supLines.map((l) => l.manufacturer));
      const f = finding({
        type: "listed_good", severity: severityOf(top), supplierId: sup.supplierId, supplierName: sup.name,
        title: `${short}: ${listJoin(byCountry)}`,
        detail: `${lineIds.length} invoice lines (${aud(spend)}). ${listJoin([...new Set(hits.map((h) => `${h.good.toLowerCase()} from ${h.country}`))], 6)} ${hits.length > 1 ? "are" : goodsPhrase([hits[0].good]).verb} on the US DOL List of Goods for ${listJoin(plainTypes(types))}. This is an inherent risk of the product and country, not a finding about this supplier.`,
        evidenceIds: eIds, lineIds, spendAud: spend, topics: ["high_risk_goods", "risks_and_actions"],
      });
      fIds.push(f.id);
      const goodsText = hits.map((h) => h.good).join(" ");
      const template = GOOD_ACTIONS.find((g) => g.match.test(goodsText));
      const makerText = listJoin(makers, 2);
      action({
        priority: f.severity === "high" ? 1 : 2,
        title: template ? template.title(short, makerText) : `Request supply chain evidence from ${short}`,
        detail: template ? template.text(short, makerText) : `Ask ${short} for supply chain information and a recent social audit for these goods.`,
        owner: "Operations manager", dueInDays: f.severity === "high" ? 30 : 60, supplierId: sup.supplierId, findingIds: [f.id],
      });
    }

    // Inputs named only in declarations.
    const fresh = st.declaredInputHits.filter((h) => h.supplierId === sup.supplierId && !h.corroboratesInvoices);
    if (fresh.length) {
      const top = Math.max(...fresh.map((h) => (LISTING_SCORE[h.exploitationType] ?? 1.5) - 0.25));
      score = Math.max(score, top);
      const pairs = [...new Set(fresh.map((h) => pairText(`${h.good} from ${h.country}`)))];
      const eIds = ev((e) => e.tool === "declared_inputs_screen" && e.supplierIds.includes(sup.supplierId));
      eIds.forEach((id) => supEvidence.add(id));
      reasons.push(`its declaration names ${listJoin(pairs)} as upstream inputs`);
      const f = finding({
        type: "declared_input", severity: severityOf(top), supplierId: sup.supplierId, supplierName: sup.name,
        title: `${short}: upstream ${listJoin(pairs)}`,
        detail: `The supplier's declaration names inputs that invoices do not show: ${listJoin(pairs)} (${listJoin([...new Set(fresh.map((h) => h.exploitationType))])}).`,
        evidenceIds: eIds, lineIds: [], spendAud: 0, topics: ["high_risk_goods", "countries", "risks_and_actions"],
      });
      fIds.push(f.id);
      if (!hits.some((h) => /lithium/i.test(h.good)) || !fresh.some((h) => /lithium/i.test(h.good))) {
        action({ priority: 2, title: `Trace upstream inputs with ${short}`, detail: `Ask ${short} to name the suppliers of ${listJoin([...new Set(fresh.map((h) => h.good.toLowerCase()))])} and their countries.`, owner: "Operations manager", dueInDays: 60, supplierId: sup.supplierId, findingIds: [f.id] });
      }
    }

    // High-risk sectors.
    for (const h of st.sectorHits.filter((x) => x.subjectType === "supplier" && x.subjectId === sup.supplierId)) {
      const pts = /labour hire/i.test(h.sector) ? 2.25 : /construction/i.test(h.sector) ? 1.5 : 1.25;
      score = Math.max(score, pts);
      const eIds = ev((e) => e.tool === "sector_risk_check" && e.supplierIds.includes(sup.supplierId));
      eIds.forEach((id) => supEvidence.add(id));
      reasons.push(`high-risk sector (${h.sector.toLowerCase()})`);
      const f = finding({
        type: "sector", severity: severityOf(pts), supplierId: sup.supplierId, supplierName: sup.name,
        title: `${short}: ${h.sector}`, detail: h.basis, evidenceIds: eIds, lineIds: [], spendAud: sup.spendAud,
        topics: ["labour_and_subcontractors", "risks_and_actions"],
      });
      fIds.push(f.id);
      if (/labour hire/i.test(h.sector)) {
        action({
          priority: 1, title: `Check ${short} pay records each quarter`,
          detail: `Each quarter, check a sample of ${short} pay records against the Cleaning Services Award, confirm in writing that no worker pays recruitment fees, and brief labour hire workers on the grievance mechanism at induction.`,
          owner: "HR manager", dueInDays: 30, supplierId: sup.supplierId, findingIds: [f.id],
        });
      }
    }

    // Sanctions alerts that were not cleared.
    for (const a of (st.sanctions?.alerts ?? []).filter((x) => x.verdict === "possible_match" && x.entityId.includes(sup.supplierId))) {
      score = Math.max(score, 3);
      reasons.push(`possible sanctions match: ${a.listedName}`);
      const f = finding({ type: "sanctions_alert", severity: "high", supplierId: sup.supplierId, supplierName: sup.name, title: `${short}: possible sanctions match`, detail: a.reasons.join(" "), evidenceIds: a.evidenceId ? [a.evidenceId] : [], lineIds: [], spendAud: sup.spendAud, topics: ["sanctions", "risks_and_actions"] });
      fIds.push(f.id);
      action({ priority: 1, title: `Pause payments to ${short} pending sanctions review`, detail: `A person must review the possible match with ${a.listedName}. Get legal advice before any further dealings.`, owner: "Owner", dueInDays: 1, supplierId: sup.supplierId, findingIds: [f.id] });
    }

    // Lines with no origin recorded.
    const unknown = lines.filter((l) => l.supplierId === sup.supplierId && !l.originCountry);
    if (unknown.length) {
      score = Math.max(score, 0.5);
      const eIds = ev((e) => e.tool === "origin_summary" && e.supplierIds.includes(sup.supplierId));
      eIds.forEach((id) => supEvidence.add(id));
      reasons.push(`no country of origin recorded for ${listJoin([...new Set(unknown.map((l) => productName(l.description)))])}`);
      const f = finding({
        type: "unknown_origin", severity: "low", supplierId: sup.supplierId, supplierName: sup.name,
        title: `${short}: origin not recorded`, detail: `No country of origin for ${listJoin([...new Set(unknown.map((l) => productName(l.description)))])}.`,
        evidenceIds: eIds, lineIds: unknown.map((l) => l.lineId), spendAud: unknown.reduce((a, l) => a + l.amountAud, 0), topics: ["countries"],
      });
      fIds.push(f.id);
      action({ priority: 3, title: `Ask ${short} for country of origin`, detail: `Ask ${short} where these are made: ${listJoin([...new Set(unknown.map((l) => productName(l.description)))])}. Record the answer on future invoices.`, owner: "Accounts", dueInDays: 30, supplierId: sup.supplierId, findingIds: [f.id] });
    }

    // Mitigations from declarations.
    if (decl && score > 0) {
      const audit = decl.thirdPartyAudit.trim();
      if (audit && !/^none|not shared|not provided/i.test(audit) && !/results not shared/i.test(audit)) {
        score = Math.max(0.25, score - 0.5);
        mitigations.push(`third-party social audit provided: ${audit}`);
      }
      if (decl.hasCodeOfConduct) mitigations.push("supplier has a code of conduct");
      const declEv = ev((e) => (e.tool === "declared_inputs_screen" || e.tool === "supplier_overview") && e.supplierIds.includes(sup.supplierId));
      declEv.forEach((id) => supEvidence.add(id));
    }
    if (!decl && score >= 1.75) {
      reasons.push("no declaration received");
      action({ priority: 2, title: `Get a declaration from ${short}`, detail: `Send the supplier declaration request to ${short} again and follow up by phone.`, owner: "Accounts", dueInDays: 21, supplierId: sup.supplierId, findingIds: fIds });
    }

    score = Math.round(score * 100) / 100;
    risks.push({
      supplierId: sup.supplierId, name: sup.name, spendAud: sup.spendAud, level: levelOf(score), score, reasons, mitigations,
      findingIds: fIds, evidenceIds: [...supEvidence], declaration: decl ? `${decl.declId}${decl.link?.confirmed ? "" : " (link awaiting review)"}` : undefined,
    });
  }

  // Own operations and policy gaps.
  for (const h of st.sectorHits.filter((x) => x.subjectType === "own_operations")) {
    const eIds = ev((e) => e.tool === "sector_risk_check" && e.supplierIds.length === 0);
    finding({ type: "sector", severity: "medium", title: `Own operations: ${h.sector}`, detail: h.basis, evidenceIds: eIds, lineIds: [], spendAud: 0, topics: ["labour_and_subcontractors", "risks_and_actions"] });
  }
  if (st.profile) {
    const gap = (key: string, title: string, detail: string, act: string, topics: Topic[]) => {
      if (st.profile![key]?.detail) return;
      const eIds = ev((e) => e.tool === "profile_evidence" && (e.data?.item === key));
      const f = finding({ type: "policy_gap", severity: "low", title, detail, evidenceIds: eIds, lineIds: [], spendAud: 0, topics });
      action({ priority: 2, title, detail: act, owner: "Owner", dueInDays: 90, findingIds: [f.id] });
    };
    gap("modern_slavery_policy", "Adopt a modern slavery policy", "No standalone modern slavery policy is recorded.", "Adopt a short modern slavery policy covering due diligence, remediation, grievance handling and client notification.", ["policy", "risks_and_actions"]);
    gap("remediation_process", "Document a remediation process", "No remediation process is recorded.", "Write down what you will do if modern slavery is found: who acts, how workers are protected, and how you work with the supplier before ending the relationship.", ["policy", "risks_and_actions"]);
  }

  risks.sort((a, b) => b.score - a.score || b.spendAud - a.spendAud);
  actions.sort((a, b) => a.priority - b.priority || a.dueInDays - b.dueInDays);
  st.findings = findings;
  st.actions = actions;
  st.supplierRisks = risks;

  // Risk levels go to the World Model every iteration, so the fact history
  // shows how the assessment changed. Findings are written once, at the end.
  for (const r of risks) await writeRisk(ctx, r);
  const counts = { High: 0, Medium: 0, Low: 0, "Not flagged": 0 };
  for (const r of risks) counts[r.level]++;
  ctx.trace.log("risk", "finding", `Risk register: ${counts.High} high, ${counts.Medium} medium, ${counts.Low} low, ${counts["Not flagged"]} not flagged`, {
    data: { counts, findings: findings.length, actions: actions.length, top: risks.slice(0, 5).map((r) => `${r.name}: ${r.level} (${r.score})`) },
  });
  void lc;
}
