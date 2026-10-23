// Run context shared by every agent: the data layer, the model router, the
// World Model (shared state across agents and across runs), the trace, and
// the working state of this assessment.
import type { FederatedData } from "../data/federated.ts";
import type { QueryRow } from "../data/source.ts";
import type { WorldModel } from "../engines/world-model/index.ts";
import type { LlmRouter } from "../llm/router.ts";
import type { Trace } from "../trace/trace.ts";
import type {
  Action, Coverage, Draft, Escalation, Evidence, Finding, Question, SupplierRisk, Task, ToolName, Topic, Verdict,
} from "./types.ts";

export interface SupplierInfo {
  supplierId: string;
  name: string;
  matchKey: string;
  abn: string;
  country: string;
  state: string;
  category: string;
  parentCompany: string;
  emailDomain: string;
  spendAud: number;
  lineCount: number;
  unknownOriginLines: number;
  entityId: string;
}

export interface DeclarationInfo {
  declId: string;
  supplierName: string;
  abn: string;
  email: string;
  submittedAt: string;
  originCountries: string;
  manufacturers: string;
  hasCodeOfConduct: boolean;
  thirdPartyAudit: string;
  recruitmentFeesPolicy: string;
  notes: string;
  link?: { supplierId: string; method: "abn" | "email_domain" | "name_exact" | "name_auto_merge" | "name_review"; confirmed: boolean; similarity?: number };
}

export interface LineInfo {
  lineId: string;
  supplierId: string;
  supplierName: string;
  invoiceNo: string;
  invoiceDate: string;
  description: string;
  amountAud: number;
  originCountry: string;
  manufacturer: string;
  manufacturerKey: string;
}

export interface LineHit {
  lineId: string;
  supplierId: string;
  good: string;
  country: string;
  exploitationType: string;
  listYear: number;
  sourceUrl: string;
  via: "taxonomy" | "classifier";
  keyword?: string;
}

export interface DeclaredInputHit {
  declId: string;
  supplierId?: string;
  good: string;
  country: string;
  exploitationType: string;
  keyword: string;
  sourceUrl: string;
  corroboratesInvoices: boolean;
}

export interface SectorHit {
  subjectType: "supplier" | "own_operations";
  subjectId: string;
  subjectName: string;
  sector: string;
  basis: string;
  sourceUrl: string;
}

export interface SanctionAlert {
  entityId: string;
  screenedName: string;
  listId: string;
  listedName: string;
  entityType: string;
  citizenship: string;
  address: string;
  regime: string;
  score: number;
  verdict: "false_positive" | "possible_match";
  reasons: string[];
  evidenceId?: string;
}

export interface RunState {
  runId: string;
  startedAt: string;
  periodFrom: string;
  periodTo: string;
  company: string;
  client: string;
  questionnaireTitle: string;
  questions: Question[];
  profile?: Record<string, { detail: string; source: string; updatedAt: string }>;
  approvals: Record<string, string>;
  suppliers: Map<string, SupplierInfo>;
  declarations: DeclarationInfo[];
  lines?: LineInfo[];
  originSummary: { origin: string; lineCount: number; spendAud: number }[];
  lineHits: LineHit[];
  lineCategories: Map<string, Set<string>>;
  declaredInputHits: DeclaredInputHit[];
  sectorHits: SectorHit[];
  sanctions?: {
    scope: "suppliers" | "extended";
    threshold: number;
    listSource: string;
    listNames: number;
    screened: { entityId: string; name: string; role: string }[];
    alerts: SanctionAlert[];
    nearest: { entityId: string; screenedName: string; listedName: string; score: number }[];
  };
  manufacturers: { entityId: string; name: string; country: string; variants: string[]; lineIds: string[]; supplierIds: string[] }[];
  pendingIdentity: { proposalId: string; declId: string; supplierId: string; similarity: number; recommendation: string; reasons: string[] }[];
  toolsRun: { tool: ToolName; params: Record<string, unknown>; iteration: number; evidenceIds: string[]; summary: string; ms: number }[];
  evidence: Evidence[];
  findings: Finding[];
  actions: Action[];
  supplierRisks: SupplierRisk[];
  drafts: Map<string, Draft[]>;
  verdicts: Map<string, Verdict[]>;
  escalations: Escalation[];
  pendingTasks: Task[];
}

export interface RunContext {
  data: FederatedData;
  llm: LlmRouter;
  world: WorldModel;
  trace: Trace;
  state: RunState;
  /** Wall-clock time for agent assertions in the World Model. */
  now(): string;
}

export function newState(runId: string, opts: { company: string; client: string; questionnaireTitle: string; periodFrom: string; periodTo: string }): RunState {
  return {
    runId,
    startedAt: new Date().toISOString(),
    ...opts,
    questions: [],
    approvals: {},
    suppliers: new Map(),
    declarations: [],
    originSummary: [],
    lineHits: [],
    lineCategories: new Map(),
    declaredInputHits: [],
    sectorHits: [],
    manufacturers: [],
    pendingIdentity: [],
    toolsRun: [],
    evidence: [],
    findings: [],
    actions: [],
    supplierRisks: [],
    drafts: new Map(),
    verdicts: new Map(),
    escalations: [],
    pendingTasks: [],
  };
}

export function addEvidence(ctx: RunContext, e: Omit<Evidence, "id" | "iteration" | "tables" | "systems"> & { tables?: string[]; systems?: string[] }): Evidence {
  const queries = e.queryIds.map((id) => ctx.data.query(id)).filter((q) => !!q);
  const evidence: Evidence = {
    ...e,
    id: `E-${ctx.state.evidence.length + 1}`,
    iteration: ctx.trace.iteration,
    tables: e.tables ?? [...new Set(queries.flatMap((q) => q!.tables))].sort(),
    systems: e.systems ?? [...new Set(queries.flatMap((q) => q!.systems))].sort(),
  };
  ctx.state.evidence.push(evidence);
  return evidence;
}

export function evidenceById(ctx: RunContext, id: string): Evidence | undefined {
  return ctx.state.evidence.find((e) => e.id === id);
}

export function evidenceForTopic(ctx: RunContext, topic: Topic): Evidence[] {
  return ctx.state.evidence.filter((e) => e.topics.includes(topic));
}

export function toolRan(ctx: RunContext, tool: ToolName, match?: (params: Record<string, unknown>) => boolean): boolean {
  return ctx.state.toolsRun.some((t) => t.tool === tool && (!match || match(t.params)));
}

export const aud = (v: number) => `AUD ${Math.round(v).toLocaleString("en-AU")}`;

export function rowsToMap(rows: QueryRow[], key: string): Map<string, QueryRow> {
  return new Map(rows.map((r) => [String(r[key]), r]));
}

export function listJoin(items: string[], max = 6): string {
  const uniq = [...new Set(items.filter(Boolean))];
  if (uniq.length <= max) return uniq.length > 1 ? `${uniq.slice(0, -1).join(", ")} and ${uniq.at(-1)}` : (uniq[0] ?? "");
  return `${uniq.slice(0, max).join(", ")} and ${uniq.length - max} more`;
}
