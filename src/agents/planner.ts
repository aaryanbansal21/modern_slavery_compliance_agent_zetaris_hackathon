// Planner agent. Chooses which tools to run each iteration. The model plans
// from the questions, the tool catalogue, what has run and the evaluator's
// feedback; the orchestrator then enforces the non-negotiables: every tool
// the evaluator requested is included, dependencies run first, and nothing
// runs twice with the same parameters.
import { z } from "zod";
import { config } from "../config.ts";
import { type RunContext } from "./context.ts";
import { PLANNER_SYSTEM } from "./prompts.ts";
import { alreadyRan, normalizeParams, TOOLS, toolSpec } from "./tools.ts";
import type { Task, ToolName, Verdict } from "./types.ts";

const PlanOut = z.object({
  rationale: z.string(),
  tasks: z.array(z.object({
    tool: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().optional(),
    forQuestions: z.array(z.string()).optional(),
  })),
});

/** Proportionate default: tier 1 checks first, deeper checks when the evaluator asks for them. */
function policyPlan(ctx: RunContext, iteration: number, requested: Task[]): z.infer<typeof PlanOut> {
  if (iteration === 1) {
    return {
      rationale: "Start with the tier 1 checks that give every question a first draft: company records, the supplier base and declarations, recorded origins, high-risk sectors and a sanctions screen of supplier names. Deeper checks run when the evaluator finds the evidence insufficient.",
      tasks: [
        { tool: "profile_evidence", params: {}, reason: "Policies, training, grievance and board decisions (Q1, Q7, Q8, Q10)" },
        { tool: "supplier_overview", params: {}, reason: "Suppliers, spend and declarations (Q3, Q5, Q6)" },
        { tool: "origin_summary", params: {}, reason: "Countries of origin (Q2)" },
        { tool: "sector_risk_check", params: {}, reason: "Labour hire and other high-risk sectors (Q5, Q9)" },
        { tool: "sanctions_screen", params: { scope: "suppliers", threshold: 0.85 }, reason: "Sanctions screen of supplier names (Q4)" },
      ],
    };
  }
  return {
    rationale: requested.length
      ? `The evaluator rejected drafts for lack of evidence. Run the checks it asked for: ${[...new Set(requested.map((t) => t.tool))].join(", ")}.`
      : "No further checks requested. Redraft with the evaluator's feedback.",
    tasks: requested.map((t) => ({ tool: t.tool, params: t.params, reason: t.reason, forQuestions: t.forQuestions })),
  };
}

export async function planIteration(ctx: RunContext, iteration: number, feedback: Verdict[]): Promise<Task[]> {
  const requested = feedback.flatMap((v) => v.requestedTools);
  const mode = config.agent.plannerMode;
  const policy = () => policyPlan(ctx, iteration, requested);
  const messages = [
    { role: "system" as const, content: PLANNER_SYSTEM },
    {
      role: "user" as const,
      content: JSON.stringify({
        iteration,
        questions: ctx.state.questions.map((q) => ({ id: q.id, topic: q.topic, text: q.text })),
        tools: TOOLS.map((t) => ({ name: t.name, tier: t.tier, params: t.params, description: t.description })),
        alreadyRun: ctx.state.toolsRun.map((t) => ({ tool: t.tool, params: t.params, iteration: t.iteration, summary: t.summary.slice(0, 300) })),
        evaluatorFeedback: feedback.filter((v) => v.verdict !== "approve").map((v) => ({
          question: v.questionId, verdict: v.verdict, issues: v.issues.map((i) => i.detail), requestedTools: v.requestedTools.map((t) => ({ tool: t.tool, params: t.params })),
        })),
      }),
    },
  ];
  const { value, meta } = mode === "policy"
    ? { value: policy(), meta: { provider: "policy" as const, model: "deterministic policy" } }
    : await ctx.llm.json("planner", `Plan iteration ${iteration}`, messages, PlanOut, policy, { temperature: 0.1, maxTokens: 900 });

  const tasks: Task[] = [];
  const deferred: string[] = [];
  const push = (t: Task) => {
    // Proportionate due diligence: in tiered mode the model's first plan uses
    // tier 1 tools only. Deeper checks run when the evaluator asks for them.
    if (mode === "tiered" && iteration === 1 && t.requestedBy !== "evaluator" && toolSpec(t.tool)?.tier === 2) {
      deferred.push(t.tool);
      return;
    }
    const params = normalizeParams(t.tool, t.params);
    const task = { ...t, params };
    if (alreadyRan(ctx, task)) return;
    if (tasks.some((x) => x.tool === task.tool && JSON.stringify(x.params) === JSON.stringify(params))) return;
    // A broader screen replaces a narrower one in the same plan.
    if (task.tool === "sanctions_screen") {
      const idx = tasks.findIndex((x) => x.tool === "sanctions_screen");
      if (idx >= 0) {
        if (params.scope === "extended") tasks.splice(idx, 1);
        else return;
      }
    }
    tasks.push(task);
  };

  for (const t of value.tasks) {
    if (!toolSpec(t.tool)) {
      ctx.trace.log("planner", "warning", `Ignored unknown tool "${t.tool}" from the model plan`);
      continue;
    }
    push({ tool: t.tool as ToolName, params: t.params ?? {}, reason: t.reason ?? "", forQuestions: t.forQuestions ?? [], requestedBy: meta.provider === "nightshift" ? "planner" : "policy" });
  }
  for (const t of requested) push(t); // evaluator requests are non-negotiable

  // Dependencies first.
  const ordered: Task[] = [];
  const visit = (t: Task, depth = 0) => {
    if (depth > 5) return;
    for (const dep of toolSpec(t.tool)?.dependsOn?.(t.params) ?? []) {
      const depTask: Task = { tool: dep, params: normalizeParams(dep, {}), reason: `Needed before ${t.tool}`, forQuestions: t.forQuestions, requestedBy: "dependency" };
      if (!alreadyRan(ctx, depTask) && !ordered.some((x) => x.tool === dep)) {
        const planned = tasks.find((x) => x.tool === dep);
        visit(planned ?? depTask, depth + 1);
      }
    }
    if (!ordered.some((x) => x.tool === t.tool && JSON.stringify(x.params) === JSON.stringify(t.params))) ordered.push(t);
  };
  for (const t of tasks) visit(t);

  if (deferred.length) {
    ctx.trace.log("planner", "info", `Deferred tier 2 tools to the evaluator: ${[...new Set(deferred)].join(", ")}`, {
      detail: "Proportionate due diligence: deeper checks run when the evaluator finds the tier 1 evidence insufficient (PLANNER_MODE=tiered).",
    });
  }
  ctx.trace.log("planner", "plan", `Iteration ${iteration} plan: ${ordered.map((t) => t.tool + (t.tool === "sanctions_screen" ? `(${t.params.scope})` : "")).join(", ") || "redraft only"}`, {
    detail: value.rationale,
    data: { rationale: value.rationale, tasks: ordered.map((t) => ({ tool: t.tool, params: t.params, reason: t.reason, requestedBy: t.requestedBy })), plannerModel: meta.model },
  });
  return ordered;
}
