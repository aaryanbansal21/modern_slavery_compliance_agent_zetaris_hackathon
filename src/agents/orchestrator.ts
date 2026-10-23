// Orchestrator. Runs the loop:
//
//   Parser -> Planner -> Executor (tools over Zetaris) -> Risk scorer
//          -> Drafter -> Evaluator --revise--> Planner (requested tools) ...
//                                 --escalate--> a person (owner sign-off, identity link, sanctions)
//                                 --approve--> final answer
//
// It stops when nothing is left to revise, or after MAX_ITERATIONS, when
// anything still unresolved is escalated instead of sent.
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { FederatedData, openDataSource } from "../data/federated.ts";
import { readManifest } from "../data/prepare.ts";
import type { DataSource } from "../data/source.ts";
import type { WorldModel } from "../engines/world-model/index.ts";
import { LlmRouter } from "../llm/router.ts";
import { Trace, type TraceEvent } from "../trace/trace.ts";
import { newState, type RunContext } from "./context.ts";
import { draftAnswers } from "./drafter.ts";
import { evaluateDrafts } from "./evaluator.ts";
import { planIteration } from "./planner.ts";
import { parseQuestionnaire, readQuestionnaireText } from "./questionnaire.ts";
import { scoreRisks } from "./risk.ts";
import { runTool } from "./tools.ts";
import type { AnswerStatus, Coverage, FinalAnswer, Question, RunSummary, Verdict } from "./types.ts";
import { ids, openWorld, writeAnswer, writeFinding } from "./world.ts";

export interface RunOptions {
  questionnaireFile?: string;
  questionnaireText?: string;
  runId?: string;
  data?: DataSource;
  world?: WorldModel;
  offlineAi?: boolean;
  assessmentDate?: string;
  onTrace?: (e: TraceEvent) => void;
  writeFiles?: boolean;
}

export const DEFAULT_QUESTIONNAIRE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "demo", "questionnaire.md");

export function runsDir(): string {
  return path.join(config.dataDir, "runs");
}

function period(dateIso: string): { from: string; to: string } {
  const to = new Date(`${dateIso}T00:00:00Z`);
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  from.setUTCDate(from.getUTCDate() + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
}

export async function runAssessment(opts: RunOptions = {}): Promise<RunSummary> {
  const runId = opts.runId ?? newRunId();
  const dir = path.join(runsDir(), runId);
  const trace = new Trace(runId, opts.writeFiles === false ? undefined : dir);
  if (opts.onTrace) trace.subscribe(opts.onTrace);

  const source = opts.data ?? (await openDataSource());
  const data = new FederatedData(source, trace);
  const llm = new LlmRouter(trace, { offline: opts.offlineAi });
  const world = opts.world ?? openWorld();
  const assessmentDate = opts.assessmentDate ?? config.assessmentDate ?? new Date().toISOString().slice(0, 10);
  const { from, to } = period(assessmentDate);

  const text = opts.questionnaireText ?? (await readQuestionnaireText(opts.questionnaireFile ?? DEFAULT_QUESTIONNAIRE));
  const state = newState(runId, { company: "Our company", client: "Client", questionnaireTitle: "Questionnaire", periodFrom: from, periodTo: to });
  const ctx: RunContext = { data, llm, world, trace, state, now: () => new Date().toISOString() };

  trace.log("orchestrator", "run", `Run ${runId} started`, {
    detail: `Data: ${source.label}. AI: ${llm.offline ? "deterministic policies (AI_MODE=mock)" : `Meterless Nightshift at ${config.nightshift.baseUrl}`}. Period ${from} to ${to}.`,
    data: { dataMode: source.mode, aiMode: llm.offline ? "mock" : "nightshift", models: config.nightshift.models, worldNamespace: world.namespace },
  });

  try {
    // Parse the questionnaire.
    const parsed = await parseQuestionnaire(text, llm);
    state.questions = parsed.questions;
    state.client = parsed.client;
    state.questionnaireTitle = parsed.title;
    for (const q of state.questions) {
      await world.upsertEntity({ type: "question", externalKey: { system: "questionnaire", id: q.id }, name: q.text, attrs: { topic: q.topic, client: state.client }, source: { kind: "questionnaire", at: ctx.now(), runId } });
    }
    trace.log("parser", "info", `Parsed ${state.questions.length} questions from "${parsed.title}"`, {
      data: { questions: state.questions.map((q) => ({ id: q.id, topic: q.topic })) },
    });

    let feedback: Verdict[] = [];
    let iteration = 0;
    const max = config.agent.maxIterations;
    while (iteration < max) {
      iteration++;
      trace.iteration = iteration;
      const evidenceBefore = state.evidence.length;
      const tasks = await planIteration(ctx, iteration, feedback);

      for (const task of tasks) {
        trace.log("executor", "tool", `Running ${task.tool}`, { detail: task.reason, data: { tool: task.tool, params: task.params, requestedBy: task.requestedBy } });
        try {
          const res = await runTool(ctx, task);
          trace.log("executor", "info", `${task.tool} finished: ${res.evidenceIds.length} evidence items`, { data: { tool: task.tool, evidenceIds: res.evidenceIds } });
        } catch (err) {
          trace.log("executor", "error", `${task.tool} failed`, { detail: (err as Error).message });
          state.toolsRun.push({ tool: task.tool, params: task.params, iteration, evidenceIds: [], summary: `FAILED: ${(err as Error).message}`, ms: 0 });
        }
      }

      if (tasks.length) await scoreRisks(ctx);

      // Draft every question on the first pass; afterwards only the ones the
      // evaluator sent back, plus any whose topic gained new evidence.
      const fresh = state.evidence.slice(evidenceBefore);
      const freshTopics = new Set(fresh.flatMap((e) => e.topics));
      const revise = new Set(feedback.filter((v) => v.verdict === "revise").map((v) => v.questionId));
      const toDraft = iteration === 1 ? state.questions : state.questions.filter((q) => revise.has(q.id) || freshTopics.has(q.topic));
      if (!toDraft.length) break;
      const prior = new Map(feedback.map((v) => [v.questionId, v]));
      const drafts = await draftAnswers(ctx, toDraft, prior);
      const verdicts = await evaluateDrafts(ctx, state.questions, drafts);
      for (const v of verdicts) {
        const d = drafts.find((x) => x.questionId === v.questionId)!;
        await writeAnswer(ctx, v.questionId, d.answer, v.verdict);
      }

      const counts = { approve: 0, revise: 0, escalate: 0 };
      verdicts.forEach((v) => counts[v.verdict]++);
      trace.log("orchestrator", "info", `Iteration ${iteration}: ${counts.approve} approved, ${counts.revise} sent back, ${counts.escalate} escalated`, { data: counts });
      feedback = verdicts;
      if (!counts.revise) break;
    }

    // Final findings into the World Model.
    for (const f of state.findings) await writeFinding(ctx, f);
    const summary = buildSummary(ctx, source.mode);
    trace.log("orchestrator", "run", `Run ${runId} finished`, {
      detail: `${summary.answers.filter((a) => a.status === "approved").length} answers approved, ${summary.escalations.filter((e) => e.status === "open").length} items need a person, ${summary.findings.length} findings, ${summary.actions.length} actions.`,
      data: { iterations: summary.iterations, world: summary.world },
    });
    if (opts.writeFiles !== false) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(summary, null, 2));
    }
    return summary;
  } finally {
    if (!opts.data) await source.close();
  }
}

function statusFor(ctx: RunContext, q: Question, last?: Verdict): AnswerStatus {
  if (!last) return "unresolved";
  if (last.verdict === "approve") return "approved";
  const esc = ctx.state.escalations.filter((e) => e.questionIds.includes(q.id) && e.status === "open");
  if (esc.some((e) => e.type === "owner_approval")) return "needs_sign_off";
  if (esc.some((e) => e.type === "sanctions_review" || e.type === "identity_review")) return "needs_review";
  return "unresolved";
}

function buildSummary(ctx: RunContext, dataMode: "zetaris" | "local"): RunSummary {
  const st = ctx.state;
  const answers: FinalAnswer[] = st.questions.map((q) => {
    const drafts = st.drafts.get(q.id) ?? [];
    const verdicts = st.verdicts.get(q.id) ?? [];
    const last = verdicts.at(-1);
    const lastDraft = drafts.at(-1);
    return {
      question: q,
      status: statusFor(ctx, q, last),
      answer: lastDraft?.answer ?? "",
      citations: lastDraft?.citations ?? [],
      iterations: drafts.length,
      history: drafts.map((d) => {
        const v = verdicts.find((x) => x.iteration === d.iteration);
        return {
          iteration: d.iteration,
          verdict: v?.verdict ?? "approve",
          summary: v?.summary ?? "",
          answer: d.answer,
          issues: (v?.issues ?? []).map((i) => ({ gate: i.gate, detail: i.detail })),
          notes: v?.notes ?? [],
          reviewer: v?.reviewer.model ?? "",
          drafter: d.model,
          requestedTools: [...new Set((v?.requestedTools ?? []).map((t) => t.tool))],
        };
      }),
      escalationIds: st.escalations.filter((e) => e.questionIds.includes(q.id)).map((e) => e.id),
    };
  });
  const lines = st.lines ?? [];
  const coverage: Coverage = {
    periodFrom: st.periodFrom,
    periodTo: st.periodTo,
    suppliers: st.suppliers.size,
    spendAud: [...st.suppliers.values()].reduce((a, s) => a + s.spendAud, 0),
    lines: lines.length,
    linesWithOrigin: lines.filter((l) => l.originCountry).length,
    spendWithOrigin: lines.filter((l) => l.originCountry).reduce((a, l) => a + l.amountAud, 0),
    lineScreenDone: st.toolsRun.some((t) => t.tool === "line_origin_screen"),
    declaredInputsDone: st.toolsRun.some((t) => t.tool === "declared_inputs_screen"),
    declarations: st.declarations.length,
    declarationsLinked: st.declarations.filter((d) => d.link?.confirmed).length,
    suppliersWithDeclaration: new Set(st.declarations.filter((d) => d.link).map((d) => d.link!.supplierId)).size,
    sanctionsScope: st.sanctions?.scope ?? "none",
    namesScreened: st.sanctions?.screened.length ?? 0,
    sanctionsListNames: st.sanctions?.listNames ?? 0,
  };
  const manifest = readManifest();
  return {
    runId: st.runId,
    startedAt: st.startedAt,
    finishedAt: new Date().toISOString(),
    company: st.company,
    client: st.client,
    questionnaireTitle: st.questionnaireTitle,
    dataMode,
    aiMode: ctx.llm.offline ? "mock" : "nightshift",
    iterations: ctx.trace.iteration,
    answers,
    supplierRisks: st.supplierRisks,
    findings: st.findings,
    actions: st.actions,
    escalations: st.escalations,
    evidence: st.evidence,
    queries: ctx.data.queries,
    coverage,
    models: Object.fromEntries(Object.entries(ctx.llm.stats.byRole)),
    llmStats: ctx.llm.stats,
    world: ctx.world.stats(),
    sources: {
      sanctions: dataMode === "zetaris" ? "As loaded in Zetaris (rs_ref.dfat_sanctions)" : manifest?.sanctions.source ?? "unknown",
      dolGoods: manifest?.dolGoods.source ?? "unknown",
      sanctionsNote: manifest?.sanctions.note ?? "",
    },
  };
}

export { ids };
