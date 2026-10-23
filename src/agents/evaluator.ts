// Evaluator agent. Every draft passes deterministic evidence gates first,
// then a review by the evaluator model, which defaults to an NVIDIA
// Nemotron route through Nightshift: a different model family from the
// drafter, so no answer is graded by the model that wrote it.
//
// Gates:
//   citations           every claim cites evidence that exists
//   evidence_sufficiency the checks the topic needs have run (else: request tools)
//   contradiction       no "no risk" claim while the risk register disagrees
//   overclaim           no "fully compliant", "risk free", "guarantee"
//   commitment          commitments need the owner's approval (escalate)
//   unknowns            missing origins must be disclosed
//   sanctions_open      open sanctions alerts go to a person (escalate)
//   provisional         evidence that rests on an unconfirmed identity link is flagged
import { z } from "zod";
import { config } from "../config.ts";
import { evidenceById, toolRan, type RunContext } from "./context.ts";
import { EVALUATOR_SYSTEM } from "./prompts.ts";
import { normalizeParams, TOOLS } from "./tools.ts";
import type { Draft, Issue, Question, Task, ToolName, Topic, Verdict } from "./types.ts";

interface Requirement {
  tool: ToolName;
  params?: Record<string, unknown>;
  satisfied?: (ctx: RunContext) => boolean;
  reason: string;
}

const LINE_SCREEN: Requirement = { tool: "line_origin_screen", params: { classifyUnmatched: true }, reason: "Claims about goods need every purchase line screened by product and country of origin, not supplier-level records or self-declarations." };
const DECLARED: Requirement = { tool: "declared_inputs_screen", reason: "Inputs named in supplier declarations (components, raw materials) can carry risks that invoice origins miss." };
const SANCTIONS_EXT: Requirement = {
  tool: "sanctions_screen", params: { scope: "extended", threshold: 0.85 },
  satisfied: (ctx) => ctx.state.sanctions?.scope === "extended",
  reason: "Screening supplier legal names only misses manufacturers, parent companies and the names suppliers use in the portal.",
};
const PROFILE: Requirement = { tool: "profile_evidence", reason: "The answer needs the company's own policy and register records." };

export const CONTRACT: Record<Topic, Requirement[]> = {
  high_risk_goods: [LINE_SCREEN, DECLARED],
  countries: [{ tool: "origin_summary", reason: "Countries must come from invoice origins." }, DECLARED],
  sanctions: [SANCTIONS_EXT],
  labour_and_subcontractors: [
    { tool: "supplier_overview", reason: "Labour hire suppliers come from the supplier master." },
    { tool: "sector_risk_check", reason: "Labour hire and cleaning are high-risk sectors; the answer must reflect that." },
    PROFILE,
  ],
  due_diligence: [{ tool: "supplier_overview", reason: "Due diligence includes the supplier declarations." }, { tool: "sanctions_screen", reason: "Due diligence includes sanctions screening." }, PROFILE],
  risks_and_actions: [LINE_SCREEN, DECLARED, { tool: "sector_risk_check", reason: "Sector risks belong in the risk summary." }, SANCTIONS_EXT],
  policy: [PROFILE],
  training: [PROFILE],
  grievance: [PROFILE],
  notification: [PROFILE],
  other: [],
};

const OVERCLAIM = /\b(fully compliant|compliant with the modern slavery act|risk[- ]free|no risk at all|guarantee[ds]?|100 ?% |slavery[- ]free|ethically sourced|zero risk)\b/i;
const COMMITMENT = /\b(we will (notify|ensure|guarantee|terminate|inform)|we commit|we undertake|we promise)\b/i;
const UNKNOWN_WORDS = /\bunknown|not recorded|not confirmed|no (country of )?origin|not known|have not recorded|not yet confirmed|asked (these|the) suppliers?\b/i;
const RISKY_NEGATIVE = /risk|goods|concern|issue|supplier|sanction|match|forced|child/i;
const INCIDENT = /incident|confirmed case|case of modern slavery/i;

function gates(ctx: RunContext, q: Question, d: Draft): { issues: Issue[]; requested: Task[]; escalate: { type: "owner_approval" | "sanctions_review"; detail: string; proposal?: string }[]; notes: string[] } {
  const issues: Issue[] = [];
  const requested: Task[] = [];
  const escalate: { type: "owner_approval" | "sanctions_review"; detail: string; proposal?: string }[] = [];
  const notes: string[] = [];

  // citations
  for (const c of d.claims) {
    // Lead-ins such as "Our planned actions:" assert nothing; unknowns state a gap.
    if (c.text.trim().length < 8 || c.type === "unknown" || /:\s*$/.test(c.text.trim())) continue;
    const missing = c.citations.filter((id) => !evidenceById(ctx, id));
    if (!c.citations.length) issues.push({ gate: "citations", blocking: true, detail: `Claim has no evidence: "${c.text.slice(0, 90)}"` });
    else if (missing.length) issues.push({ gate: "citations", blocking: true, detail: `Claim cites evidence that does not exist (${missing.join(", ")}): "${c.text.slice(0, 80)}"` });
  }

  // evidence sufficiency
  for (const r of CONTRACT[q.topic]) {
    const ok = r.satisfied ? r.satisfied(ctx) : toolRan(ctx, r.tool);
    if (!ok) {
      issues.push({ gate: "evidence_sufficiency", blocking: true, detail: `${r.tool} has not run. ${r.reason}` });
      requested.push({ tool: r.tool, params: r.params ?? {}, reason: r.reason, forQuestions: [q.id], requestedBy: "evaluator" });
    }
  }

  // contradiction with the risk register
  const topicRisks = ctx.state.findings.filter((f) => (f.severity === "high" || f.severity === "medium") && f.topics.includes(q.topic));
  for (const c of d.claims.filter((x) => x.type === "negative")) {
    if (topicRisks.length && RISKY_NEGATIVE.test(c.text) && !INCIDENT.test(c.text)) {
      issues.push({ gate: "contradiction", blocking: true, detail: `"${c.text.slice(0, 90)}" conflicts with ${topicRisks.length} high or medium findings in the risk register.` });
    }
  }

  // overclaiming
  const over = d.answer.match(OVERCLAIM);
  if (over) issues.push({ gate: "overclaim", blocking: true, detail: `The answer says "${over[0]}". Evidence cannot support that.` });

  // commitments need the owner
  const commitments = d.claims.filter((c) => c.type === "commitment" || COMMITMENT.test(c.text));
  if (commitments.length && !(q.topic === "notification" && ctx.state.approvals.notification_commitment)) {
    const proposal = commitments.map((c) => c.text.replace(/^Proposed commitment \(needs owner approval\):\s*/i, "")).join(" ");
    escalate.push({ type: "owner_approval", detail: "The answer commits the business to an action. The owner must approve the wording.", proposal });
  }

  // unknowns disclosed
  const unknownLines = (ctx.state.lines ?? []).filter((l) => !l.originCountry);
  if ((q.topic === "countries" || q.topic === "high_risk_goods") && unknownLines.length && toolRan(ctx, "origin_summary") && !UNKNOWN_WORDS.test(d.answer)) {
    issues.push({ gate: "unknowns", blocking: true, detail: `${unknownLines.length} invoice lines have no country of origin. The answer must say so.` });
  }

  // open sanctions alerts
  if (q.topic === "sanctions") {
    const open = (ctx.state.sanctions?.alerts ?? []).filter((a) => a.verdict === "possible_match");
    if (open.length) escalate.push({ type: "sanctions_review", detail: `${open.length} possible sanctions match needs review by a person: ${open.map((a) => `${a.screenedName} ~ ${a.listedName}`).join("; ")}.` });
  }

  // provisional evidence
  const provisional = d.citations.filter((id) => evidenceById(ctx, id)?.provisional);
  if (provisional.length) notes.push(`Cites ${provisional.join(", ")}, which rests on an identity link awaiting human review.`);

  return { issues, requested, escalate, notes };
}

const EvalOut = z.object({
  verdict: z.enum(["approve", "revise", "escalate"]),
  issues: z.array(z.string()),
  requestedTools: z.array(z.object({ tool: z.string(), params: z.record(z.string(), z.unknown()).optional(), reason: z.string().optional() })).default([]),
  summary: z.string(),
});

export async function evaluateDrafts(ctx: RunContext, questions: Question[], drafts: Draft[]): Promise<Verdict[]> {
  const isLast = ctx.trace.iteration >= config.agent.maxIterations;
  return Promise.all(drafts.map(async (d) => {
    const q = questions.find((x) => x.id === d.questionId)!;
    const g = gates(ctx, q, d);
    const blocking = g.issues.filter((i) => i.blocking);
    const gateVerdict: Verdict["verdict"] = blocking.length ? "revise" : g.escalate.length ? "escalate" : "approve";
    const cited = d.citations.map((id) => evidenceById(ctx, id)).filter(Boolean).map((e) => ({ id: e!.id, statement: e!.statement, provisional: e!.provisional || undefined }));
    const findings = ctx.state.findings.filter((f) => f.topics.includes(q.topic)).map((f) => ({ severity: f.severity, title: f.title }));

    const { value, meta } = await ctx.llm.json(
      "evaluator",
      `Evaluate ${q.id} draft (gates: ${gateVerdict})`,
      [
        { role: "system", content: EVALUATOR_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            question: q.text,
            topic: q.topic,
            draft: d.answer,
            claims: d.claims,
            citedEvidence: cited,
            riskRegisterForTopic: findings,
            gateResults: { verdict: gateVerdict, issues: g.issues.map((i) => `${i.gate}: ${i.detail}`), escalations: g.escalate.map((e) => e.detail) },
            allowedTools: TOOLS.map((t) => ({ tool: t.name, params: t.params })),
            toolsAlreadyRun: ctx.state.toolsRun.map((t) => ({ tool: t.tool, params: t.params })),
          }),
        },
      ],
      EvalOut,
      () => ({
        verdict: gateVerdict,
        issues: [...g.issues.map((i) => i.detail), ...g.escalate.map((e) => e.detail)],
        requestedTools: [],
        summary: gateVerdict === "approve" ? "Every claim is supported by cited evidence and the required checks have run." : blocking.map((i) => i.detail).join(" ") || g.escalate.map((e) => e.detail).join(" "),
      }),
      { temperature: 0, maxTokens: 900 },
    );

    // Combine: the gates are a floor. The model can add issues, never remove a blocking gate.
    const modelTools: Task[] = value.requestedTools
      .filter((t) => TOOLS.some((x) => x.name === t.tool))
      .map((t) => ({ tool: t.tool as ToolName, params: normalizeParams(t.tool as ToolName, t.params ?? {}), reason: t.reason ?? "Requested by the evaluator model", forQuestions: [q.id], requestedBy: "evaluator" as const }))
      .filter((t) => !toolRan(ctx, t.tool, (p) => JSON.stringify(normalizeParams(t.tool, p)) === JSON.stringify(t.params)));
    const modelIssues: Issue[] = meta.provider === "nightshift"
      ? value.issues.filter((i) => !g.issues.some((x) => x.detail === i)).map((i) => ({ gate: "model_review", blocking: value.verdict === "revise", detail: i }))
      : [];

    let verdict: Verdict["verdict"] = gateVerdict;
    if (gateVerdict === "approve" && meta.provider === "nightshift") {
      if (value.verdict === "revise" && (modelTools.length || !isLast)) verdict = "revise";
      if (value.verdict === "escalate") verdict = "escalate";
    }
    if (gateVerdict === "escalate" && value.verdict === "revise" && modelTools.length) verdict = "revise";
    if (verdict === "revise" && isLast) verdict = "escalate";

    const notes = [...g.notes];
    if (meta.provider === "nightshift" && value.verdict === "revise" && verdict === "approve") notes.push(`Model suggestions not applied on the final iteration: ${value.issues.join(" ")}`);

    const issues = [...g.issues, ...modelIssues];
    const result: Verdict = {
      questionId: q.id, iteration: ctx.trace.iteration, verdict, issues,
      requestedTools: [...g.requested, ...modelTools],
      notes, reviewer: { model: meta.model, provider: meta.provider },
      summary: value.summary,
    };
    ctx.state.verdicts.set(q.id, [...(ctx.state.verdicts.get(q.id) ?? []), result]);

    // Escalations for things only a person can decide.
    for (const e of g.escalate) {
      const exists = ctx.state.escalations.find((x) => x.type === e.type && x.questionIds.includes(q.id) && x.status === "open");
      if (exists) continue;
      ctx.state.escalations.push({
        id: `X-${ctx.state.escalations.length + 1}`, type: e.type,
        title: e.type === "owner_approval" ? `Approve the commitment in ${q.id}` : `Review possible sanctions match (${q.id})`,
        detail: e.detail, questionIds: [q.id], blocking: true, status: "open",
        action: e.type === "owner_approval" ? { kind: "approve_wording", ref: q.topic === "notification" ? "notification_commitment" : q.id, proposal: e.proposal } : { kind: "legal_review" },
      });
    }
    if (verdict === "escalate" && !g.escalate.length) {
      ctx.state.escalations.push({
        id: `X-${ctx.state.escalations.length + 1}`, type: "unresolved", title: `Review ${q.id} before sending`,
        detail: [...issues.map((i) => i.detail), value.summary].filter(Boolean).join(" "), questionIds: [q.id], blocking: true, status: "open", action: { kind: "review" },
      });
    }
    for (const p of ctx.state.pendingIdentity) {
      const esc = ctx.state.escalations.find((x) => x.action?.ref === p.proposalId);
      if (esc && d.citations.some((id) => evidenceById(ctx, id)?.provisional) && !esc.questionIds.includes(q.id)) esc.questionIds.push(q.id);
    }

    ctx.trace.log("evaluator", "verdict", `${q.id}: ${verdict.toUpperCase()}`, {
      detail: verdict === "approve" ? value.summary : [...issues.map((i) => `[${i.gate}] ${i.detail}`), ...g.escalate.map((e) => `[${e.type}] ${e.detail}`)].join(" | "),
      data: { questionId: q.id, verdict, gateVerdict, modelVerdict: value.verdict, reviewer: meta.model, requestedTools: result.requestedTools.map((t) => ({ tool: t.tool, params: t.params })), notes },
    });
    return result;
  }));
}
