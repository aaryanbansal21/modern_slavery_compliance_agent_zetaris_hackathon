// Shared types for the agent system.

export type Topic =
  | "policy" | "countries" | "high_risk_goods" | "sanctions" | "labour_and_subcontractors"
  | "due_diligence" | "training" | "grievance" | "risks_and_actions" | "notification" | "other";

export const TOPICS: Topic[] = [
  "policy", "countries", "high_risk_goods", "sanctions", "labour_and_subcontractors",
  "due_diligence", "training", "grievance", "risks_and_actions", "notification", "other",
];

export interface Question {
  id: string;
  number: number;
  text: string;
  topic: Topic;
}

export type ToolName =
  | "profile_evidence" | "supplier_overview" | "origin_summary" | "sanctions_screen"
  | "sector_risk_check" | "resolve_entities" | "line_origin_screen" | "declared_inputs_screen";

export interface Task {
  tool: ToolName;
  params: Record<string, unknown>;
  reason: string;
  forQuestions: string[];
  requestedBy: "planner" | "evaluator" | "dependency" | "policy";
}

export interface Evidence {
  id: string;
  tool: ToolName;
  iteration: number;
  title: string;
  statement: string;
  topics: Topic[];
  queryIds: string[];
  tables: string[];
  systems: string[];
  supplierIds: string[];
  /** Depends on an identity link that a person has not confirmed yet. */
  provisional?: boolean;
  sourceUrls?: string[];
  data?: Record<string, unknown>;
}

export type Severity = "high" | "medium" | "low" | "info";

export type FindingType =
  | "listed_good" | "declared_input" | "sector" | "sanctions_alert" | "unknown_origin"
  | "no_declaration" | "policy_gap" | "identity_review";

export interface Finding {
  id: string;
  type: FindingType;
  severity: Severity;
  supplierId?: string;
  supplierName?: string;
  title: string;
  detail: string;
  evidenceIds: string[];
  lineIds: string[];
  spendAud: number;
  topics: Topic[];
}

export interface Action {
  id: string;
  priority: 1 | 2 | 3;
  title: string;
  detail: string;
  owner: string;
  dueInDays: number;
  supplierId?: string;
  findingIds: string[];
}

export interface SupplierRisk {
  supplierId: string;
  name: string;
  spendAud: number;
  level: "High" | "Medium" | "Low" | "Not flagged";
  score: number;
  reasons: string[];
  mitigations: string[];
  findingIds: string[];
  evidenceIds: string[];
  declaration?: string;
}

export interface Claim {
  text: string;
  type: "positive" | "negative" | "commitment" | "unknown";
  citations: string[];
}

export interface Draft {
  questionId: string;
  iteration: number;
  answer: string;
  claims: Claim[];
  citations: string[];
  model: string;
  provider: string;
}

export interface Issue {
  gate: string;
  blocking: boolean;
  detail: string;
}

export interface Verdict {
  questionId: string;
  iteration: number;
  verdict: "approve" | "revise" | "escalate";
  issues: Issue[];
  requestedTools: Task[];
  notes: string[];
  reviewer: { model: string; provider: string };
  summary: string;
}

export type EscalationType = "owner_approval" | "identity_review" | "sanctions_review" | "supplier_info" | "unresolved";

export interface Escalation {
  id: string;
  type: EscalationType;
  title: string;
  detail: string;
  questionIds: string[];
  supplierId?: string;
  blocking: boolean;
  status: "open" | "resolved";
  /** What the person can do in the UI to resolve it. */
  action?: { kind: "approve_merge" | "approve_wording" | "contact_supplier" | "legal_review" | "review"; ref?: string; proposal?: string };
}

export type AnswerStatus = "approved" | "needs_sign_off" | "needs_review" | "unresolved";

export interface FinalAnswer {
  question: Question;
  status: AnswerStatus;
  answer: string;
  citations: string[];
  iterations: number;
  history: {
    iteration: number;
    verdict: Verdict["verdict"];
    summary: string;
    answer: string;
    issues: { gate: string; detail: string }[];
    notes: string[];
    reviewer: string;
    drafter: string;
    requestedTools: string[];
  }[];
  escalationIds: string[];
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  company: string;
  client: string;
  questionnaireTitle: string;
  dataMode: "zetaris" | "local";
  aiMode: "nightshift" | "mock";
  iterations: number;
  answers: FinalAnswer[];
  supplierRisks: SupplierRisk[];
  findings: Finding[];
  actions: Action[];
  escalations: Escalation[];
  evidence: Evidence[];
  queries: import("../data/federated.ts").QueryRecord[];
  coverage: Coverage;
  models: Record<string, string>;
  llmStats: import("../llm/router.ts").LlmStats;
  world: Record<string, number>;
  sources: { sanctions: string; dolGoods: string; sanctionsNote: string };
}

export interface Coverage {
  periodFrom: string;
  periodTo: string;
  suppliers: number;
  spendAud: number;
  lines: number;
  linesWithOrigin: number;
  spendWithOrigin: number;
  lineScreenDone: boolean;
  declaredInputsDone: boolean;
  declarations: number;
  declarationsLinked: number;
  suppliersWithDeclaration: number;
  sanctionsScope: "none" | "suppliers" | "extended";
  namesScreened: number;
  sanctionsListNames: number;
}
