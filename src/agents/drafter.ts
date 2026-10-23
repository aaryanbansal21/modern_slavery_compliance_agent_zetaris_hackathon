// Drafter agent. Writes each answer from the evidence the executor gathered,
// citing evidence IDs after every claim. It sees only evidence relevant to
// the question's topic, plus the evaluator's feedback on its last attempt.
import { z } from "zod";
import { aud, evidenceForTopic, listJoin, toolRan, type RunContext } from "./context.ts";
import { DRAFTER_SYSTEM } from "./prompts.ts";
import type { Claim, Draft, Evidence, Question, Verdict } from "./types.ts";
import { capitalise, goodsPhrase, pairText, plainTypes, productName, shortName } from "../util/text.ts";

const DraftOut = z.object({
  answer: z.string().min(10),
  claims: z.array(z.object({
    text: z.string().min(3),
    type: z.enum(["positive", "negative", "commitment", "unknown"]),
    citations: z.array(z.string()),
  })).min(1),
});
type DraftValue = z.infer<typeof DraftOut>;

const byTool = (ctx: RunContext, tool: Evidence["tool"], pred: (e: Evidence) => boolean = () => true) =>
  ctx.state.evidence.filter((e) => e.tool === tool && pred(e));
const latest = (list: Evidence[]) => list.at(-1);
const cite = (...items: (Evidence | undefined)[]) => items.filter((e): e is Evidence => !!e).map((e) => e.id);
const tag = (ids: string[]) => (ids.length ? ` [${ids.join(", ")}]` : "");
const profileItem = (ctx: RunContext, item: string) => latest(byTool(ctx, "profile_evidence", (e) => e.data?.item === item));

/** Join claims into prose. Claims starting with "- " become list items on their own lines. */
function compose(claims: Claim[], extra = ""): DraftValue {
  let answer = "";
  let prevBullet = false;
  for (const c of claims) {
    const bullet = c.text.startsWith("- ");
    const piece = `${c.text}${tag(c.citations)}`;
    answer += !answer ? piece : bullet ? `\n${piece}` : prevBullet ? `\n\n${piece}` : ` ${piece}`;
    prevBullet = bullet;
  }
  if (extra) answer += `\n\n${extra}`;
  return { answer: answer.trim(), claims };
}

/** Deterministic drafting policy, used offline and when the model's output is unusable. */
export function policyDraft(ctx: RunContext, q: Question): DraftValue {
  const st = ctx.state;
  const claims: Claim[] = [];
  const add = (text: string, type: Claim["type"], citations: string[]) => claims.push({ text, type, citations });
  const supplierBase = latest(byTool(ctx, "supplier_overview", (e) => e.title === "Supplier base"));
  const decls = latest(byTool(ctx, "supplier_overview", (e) => e.title === "Supplier declarations"));
  const lineCoverage = latest(byTool(ctx, "line_origin_screen", (e) => e.title === "Line-level screen coverage"));
  const unknownLines = (st.lines ?? []).filter((l) => !l.originCountry);
  const unknownItems = [...new Set(unknownLines.map((l) => productName(l.description)))];
  const unknownEv = latest(byTool(ctx, "origin_summary", (e) => e.title === "Lines with no country of origin"));
  const upstream = byTool(ctx, "declared_inputs_screen", (e) => e.title.startsWith("Upstream input"));
  const sup = (id?: string) => (id ? shortName(st.suppliers.get(id)?.name ?? id) : "a supplier");

  switch (q.topic) {
    case "policy": {
      const code = profileItem(ctx, "supplier_code_of_conduct");
      const pol = profileItem(ctx, "modern_slavery_policy");
      const rem = profileItem(ctx, "remediation_process");
      if (code?.data?.present) add(`Yes. ${code.statement}`, "positive", cite(code));
      else if (code) add("We do not have a supplier code of conduct.", "positive", cite(code));
      if (pol && !pol.data?.present) add("We do not yet have a standalone modern slavery policy.", "positive", cite(pol));
      if (rem && !rem.data?.present) add("We have not yet documented a remediation process. Adopting both is part of our action plan in question 9.", "positive", cite(rem));
      break;
    }
    case "countries": {
      const origin = latest(byTool(ctx, "origin_summary", (e) => e.title === "Countries of origin on invoices"));
      if (origin) {
        const known = ((origin.data?.origins as { origin: string; spendAud: number }[]) ?? []).filter((o) => o.origin !== "Unknown");
        add(`Our invoices for the last 12 months record goods made in ${listJoin(known.map((o) => o.origin))}. By spend: ${known.map((o) => `${o.origin} ${aud(o.spendAud)}`).join(", ")}.`, "positive", cite(origin));
      }
      for (const u of upstream) {
        add(`${sup(u.supplierIds[0])}'s declaration adds an upstream source that our invoices do not show: ${listJoin(((u.data?.newPairs as string[]) ?? []).map(pairText))}.`, "positive", cite(u));
      }
      if (unknownLines.length) {
        add(`We have not recorded the country of origin for ${unknownLines.length} invoice lines (${listJoin(unknownItems, 4)}). We are asking these suppliers to confirm it.`, "unknown", cite(unknownEv));
      }
      break;
    }
    case "high_risk_goods": {
      if (!lineCoverage) {
        add("Our suppliers are Australian businesses.", "positive", cite(supplierBase));
        add("The supplier declarations we have received do not report forced labour or child labour.", "positive", cite(decls));
        add("We have not identified high-risk goods in our supply chain.", "negative", cite(decls));
        break;
      }
      const groups = byTool(ctx, "line_origin_screen", (e) => e.title !== "Line-level screen coverage");
      if (!groups.length && !upstream.length) {
        add("We screened every purchase line from the last 12 months against the US Department of Labor List of Goods Produced by Child Labor or Forced Labor, by product and country of origin. No product we bought matched a listed good from a listed country.", "negative", cite(lineCoverage));
      } else {
        add("Yes. We screened every purchase line from the last 12 months against the US Department of Labor List of Goods Produced by Child Labor or Forced Labor, by product and country of origin. These purchases are listed goods from listed countries:", "positive", cite(lineCoverage));
        const severity = (e: Evidence) => Math.min(...((e.data?.exploitationTypes as string[]) ?? []).map((t) => ["Forced Labor", "Forced Child Labor", "Child Labor", "Inputs Produced with Forced Labor", "Inputs Produced with Child Labor"].indexOf(t)));
        const ranked = [...groups].sort((a, b) => severity(a) - severity(b) || Number(b.data?.spendAud ?? 0) - Number(a.data?.spendAud ?? 0));
        for (const g of ranked) {
          const makers = (g.data?.makers as string[]) ?? [];
          const gp = goodsPhrase(g.data?.goods as string[]);
          add(`- ${capitalise(listJoin(g.data?.products as string[], 3))} made in ${g.data?.country}${makers.length ? ` by ${listJoin(makers, 2)}` : ""}, from ${sup(g.supplierIds[0])} (${aud(Number(g.data?.spendAud ?? 0))}). ${capitalise(gp.text)} from ${g.data?.country} ${gp.verb} listed for ${listJoin(plainTypes(g.data?.exploitationTypes as string[]))}.`, "positive", cite(g));
        }
        for (const u of upstream) {
          add(`- ${sup(u.supplierIds[0])}'s declaration names ${listJoin(((u.data?.newPairs as string[]) ?? []).map(pairText))} as an input to equipment our invoices record as made elsewhere.`, "positive", cite(u));
        }
        add("These listings show the inherent risk of a product from a country. They are not findings of forced or child labour at these suppliers. Our follow-up actions are in question 9.", "positive", cite(lineCoverage));
      }
      if (unknownLines.length) {
        const risky = unknownLines.filter((l) => st.lineCategories.has(l.lineId));
        add(`The country of origin is not recorded for ${unknownLines.length} lines (${listJoin(unknownItems, 4)}). ${risky.length ? `${risky.length} of them are in a listed product category, and we have asked those suppliers to confirm the origin.` : "None of these products is in a listed category, and we have asked the suppliers to confirm the origin."}`, "unknown", cite(unknownEv, lineCoverage));
      }
      break;
    }
    case "sanctions": {
      const scr = latest(byTool(ctx, "sanctions_screen", (e) => e.title.startsWith("Sanctions screening")));
      if (!scr) {
        add("We have not yet screened our suppliers against sanctions lists.", "unknown", []);
        break;
      }
      const alerts = byTool(ctx, "sanctions_screen", (e) => e.title.startsWith("Name alert") && e.iteration === scr.iteration);
      const roles = (scr.data?.roles as string[]) ?? [];
      const extended = scr.data?.scope === "extended";
      add(`Yes. We screened ${scr.data?.screened} names against the ${scr.data?.listSource}: ${extended ? "our suppliers, their parent companies, the manufacturers named on invoices and declarations, and the names suppliers use in our portal" : `our ${st.suppliers.size} suppliers' legal names`}. We used fuzzy name matching with a ${scr.data?.threshold} similarity threshold so that spelling variants are caught.`, "positive", cite(scr));
      void roles;
      const open = alerts.filter((a) => a.data?.verdict === "possible_match");
      const cleared = alerts.filter((a) => a.data?.verdict === "false_positive");
      for (const a of cleared) add(`One name alert, "${a.data?.screenedName}" against the listed entity "${a.data?.listedName}", was reviewed and cleared as a false positive. ${(a.data?.reasons as string[]).join(" ")}`, "positive", cite(a));
      for (const a of open) add(`The alert for "${a.data?.screenedName}" needs review by a person, with legal advice, before we deal further with this party.`, "unknown", cite(a));
      if (!open.length) add(`No ${extended ? "supplier, manufacturer or parent company" : "supplier"} we screened is a confirmed match.`, "negative", cite(scr));
      break;
    }
    case "labour_and_subcontractors": {
      const lh = byTool(ctx, "supplier_overview", (e) => e.title.startsWith("Labour hire"));
      const sec = byTool(ctx, "sector_risk_check", (e) => /labour hire|cleaning/i.test(e.title));
      const grievance = profileItem(ctx, "grievance_mechanism");
      const workforce = profileItem(ctx, "workforce");
      if (!lh.length) {
        add("We do not use labour hire or subcontractors to deliver our services.", "negative", cite(supplierBase, workforce));
        break;
      }
      const agency = st.suppliers.get(String(lh[0].data?.supplierId));
      const decl = st.declarations.find((d) => d.declId === lh[0].data?.declId);
      add(`Yes. ${workforce?.data?.present ? workforce.statement : ""}`.trim(), "positive", cite(workforce));
      if (agency) add(`The agency is ${shortName(agency.name)}, our largest supplier (${aud(agency.spendAud)} in the last 12 months).`, "positive", cite(lh[0]));
      if (sec.length) add("Cleaning and outsourced labour are recognised as high-risk sectors for modern slavery, so we treat this arrangement as a priority.", "positive", cite(...sec));
      if (decl) add(`${shortName(agency?.name ?? decl.supplierName)}'s declaration states: "${[decl.recruitmentFeesPolicy, decl.notes].filter(Boolean).join(". ").replace(/\.\./g, ".")}"`, "positive", cite(lh[0]));
      if (grievance?.data?.present) add("Labour hire workers can use our grievance mechanism.", "positive", cite(grievance));
      add(`We have not yet checked ${agency ? shortName(agency.name) : "the agency"}'s pay records ourselves. We plan to check a sample against the Cleaning Services Award each quarter.`, "unknown", cite(lh[0]));
      break;
    }
    case "due_diligence": {
      const sent = profileItem(ctx, "supplier_questionnaires");
      const audits = profileItem(ctx, "third_party_audits");
      const scr = latest(byTool(ctx, "sanctions_screen", (e) => e.title.startsWith("Sanctions screening")));
      const resolve = latest(byTool(ctx, "resolve_entities", (e) => e.title.startsWith("Identity resolution")));
      const declared = latest(byTool(ctx, "declared_inputs_screen"));
      if (sent?.data?.present) add(sent.statement, "positive", cite(sent));
      const n = st.declarations.length;
      const pending = st.declarations.filter((d) => d.link && !d.link.confirmed).length;
      if (decls) add(`${n} suppliers responded through our supplier portal.${resolve ? ` We matched each response to our supplier records by ABN, email domain or company name${pending ? `, and ${pending} match is awaiting confirmation` : ""}.` : ""}`, "positive", cite(decls, resolve));
      if (scr) add(`We screened ${scr.data?.scope === "extended" ? "supplier names, parent companies and manufacturers" : "supplier names"} against the ${scr.data?.listSource}.`, "positive", cite(scr));
      if (lineCoverage) add("We screened every purchase line from the last 12 months against the US Department of Labor List of Goods, by product and country of origin.", "positive", cite(lineCoverage));
      if (declared) add("We checked the inputs that suppliers named in their declarations against the same list.", "positive", cite(declared));
      const audited = st.declarations.filter((d) => d.link && d.thirdPartyAudit && !/^none/i.test(d.thirdPartyAudit) && !/not shared/i.test(d.thirdPartyAudit));
      for (const d of audited) {
        const e = latest(byTool(ctx, "declared_inputs_screen", (x) => x.data?.declId === d.declId)) ?? decls;
        add(`${shortName(st.suppliers.get(d.link!.supplierId)?.name ?? d.supplierName)} provided a ${d.thirdPartyAudit.charAt(0).toLowerCase()}${d.thirdPartyAudit.slice(1)}.`, "positive", cite(e));
      }
      if (audits) add(audits.statement, "positive", cite(audits));
      break;
    }
    case "training": {
      const t = profileItem(ctx, "procurement_training");
      add(t?.data?.present ? `Yes. ${t.statement}` : "Not yet. No modern slavery training is recorded.", t?.data?.present ? "positive" : "unknown", cite(t));
      break;
    }
    case "grievance": {
      const g = profileItem(ctx, "grievance_mechanism");
      add(g?.data?.present ? `Yes. ${g.statement}` : "Not yet. We have no grievance mechanism recorded.", g?.data?.present ? "positive" : "unknown", cite(g));
      break;
    }
    case "risks_and_actions": {
      if (!lineCoverage) {
        add("We have not identified modern slavery risks or incidents. Our supplier declarations did not report concerns.", "negative", cite(decls));
        break;
      }
      add("We have not confirmed any case of modern slavery in our operations or supply chain. We have identified these risks:", "positive", cite(lineCoverage));
      for (const r of st.supplierRisks.filter((x) => x.level === "High" || x.level === "Medium")) {
        add(`- ${shortName(r.name)} (${r.level.toLowerCase()} risk): ${r.reasons.join("; ")}.`, "positive", r.evidenceIds.slice(0, 3));
      }
      const own = st.findings.find((f) => f.title.startsWith("Own operations"));
      if (own) add(`Our own operations are in a high-risk sector (${own.title.replace("Own operations: ", "").toLowerCase()}).`, "positive", own.evidenceIds.slice(0, 1));
      const actions = st.actions.filter((a) => a.priority <= 2).slice(0, 7);
      if (actions.length) {
        add("Our planned actions:", "positive", []);
        for (const a of actions) {
          const ids = [...new Set(st.findings.filter((f) => a.findingIds.includes(f.id)).flatMap((f) => f.evidenceIds.slice(0, 1)))];
          add(`- ${a.title} (${a.owner.toLowerCase()}, within ${a.dueInDays} days).`, "positive", ids.slice(0, 2));
        }
      }
      break;
    }
    case "notification": {
      const n = profileItem(ctx, "client_notification_commitment");
      const approved = st.approvals.notification_commitment;
      if (approved) add(`Yes. ${approved}`, "commitment", cite(n));
      else add(`Proposed commitment (needs owner approval): We will notify ${st.client} within 10 business days if we identify modern slavery in our operations or supply chain that relates to the services we provide to ${st.client}, and we will share our remediation plan.`, "commitment", cite(n));
      break;
    }
    default: {
      const ev = evidenceForTopic(ctx, q.topic).slice(-2);
      add(ev.length ? ev.map((e) => e.statement).join(" ") : "We need more information to answer this question.", ev.length ? "positive" : "unknown", cite(...ev));
    }
  }
  if (!claims.length) add("We need more information to answer this question.", "unknown", []);
  return compose(claims.filter((c) => c.text.trim().length > 0));
}

function packFor(ctx: RunContext, q: Question) {
  const evidence = evidenceForTopic(ctx, q.topic).map((e) => ({ id: e.id, title: e.title, statement: e.statement, provisional: e.provisional || undefined }));
  const risks = ["high_risk_goods", "risks_and_actions", "labour_and_subcontractors"].includes(q.topic)
    ? ctx.state.supplierRisks.filter((r) => r.level !== "Not flagged").map((r) => ({ supplier: r.name, level: r.level, reasons: r.reasons, evidence: r.evidenceIds.slice(0, 4) }))
    : undefined;
  const actions = q.topic === "risks_and_actions"
    ? ctx.state.actions.slice(0, 10).map((a) => ({ title: a.title, detail: a.detail, owner: a.owner, dueInDays: a.dueInDays }))
    : undefined;
  return { evidence, risks, actions, approvals: q.topic === "notification" ? ctx.state.approvals : undefined };
}

export async function draftAnswers(ctx: RunContext, questions: Question[], feedback: Map<string, Verdict>): Promise<Draft[]> {
  return Promise.all(questions.map(async (q) => {
    const prior = feedback.get(q.id);
    const previous = ctx.state.drafts.get(q.id)?.at(-1);
    const pack = packFor(ctx, q);
    const { value, meta } = await ctx.llm.json(
      "drafter",
      `Draft answer to ${q.id} (${q.topic})`,
      [
        { role: "system", content: DRAFTER_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            company: ctx.state.company,
            client: ctx.state.client,
            question: { id: q.id, text: q.text, topic: q.topic },
            evidence: pack.evidence,
            supplierRisks: pack.risks,
            plannedActions: pack.actions,
            ownerApprovals: pack.approvals,
            previousDraft: previous?.answer,
            evaluatorFeedback: prior ? { verdict: prior.verdict, issues: prior.issues.map((i) => i.detail), notes: prior.notes } : undefined,
          }),
        },
      ],
      DraftOut,
      () => policyDraft(ctx, q),
      { temperature: 0.2, maxTokens: 1500 },
    );
    const known = new Set(ctx.state.evidence.map((e) => e.id));
    const claims = value.claims.map((c) => ({ ...c, citations: c.citations.map((x) => x.replace(/[[\]\s]/g, "")) }));
    const citations = [...new Set([...claims.flatMap((c) => c.citations), ...[...value.answer.matchAll(/E-\d+/g)].map((m) => m[0])])];
    const draft: Draft = {
      questionId: q.id, iteration: ctx.trace.iteration, answer: value.answer, claims, citations,
      model: meta.model, provider: meta.provider,
    };
    ctx.state.drafts.set(q.id, [...(ctx.state.drafts.get(q.id) ?? []), draft]);
    const unknownCites = citations.filter((c) => !known.has(c));
    ctx.trace.log("drafter", "draft", `${q.id} drafted (${claims.length} claims, ${citations.length} citations)`, {
      detail: value.answer.slice(0, 280),
      data: { questionId: q.id, citations, unknownCitations: unknownCites, model: meta.model },
    });
    return draft;
  }));
}

export { toolRan };
