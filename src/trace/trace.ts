// Reasoning trace. Every plan, query, model call, finding, draft and verdict
// is recorded as an event, streamed to the UI and written to
// .data/runs/<runId>/trace.jsonl, so anyone can see how the system reached
// its answers and which model handled each request.
import fs from "node:fs";
import path from "node:path";

export type AgentName =
  | "orchestrator" | "parser" | "planner" | "executor" | "resolver" | "classifier"
  | "adjudicator" | "drafter" | "evaluator" | "world-model" | "zetaris" | "nightshift" | "risk";

export type TraceType =
  | "run" | "plan" | "tool" | "query" | "llm" | "finding" | "draft" | "verdict"
  | "escalation" | "memory" | "info" | "warning" | "error";

export interface TraceEvent {
  seq: number;
  at: string;
  runId: string;
  iteration: number;
  agent: AgentName;
  type: TraceType;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
  ms?: number;
}

type Listener = (e: TraceEvent) => void;

export class Trace {
  readonly events: TraceEvent[] = [];
  iteration = 0;
  private listeners = new Set<Listener>();
  private file?: string;

  constructor(readonly runId: string, dir?: string) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, "trace.jsonl");
      fs.writeFileSync(this.file, "");
    }
  }

  log(agent: AgentName, type: TraceType, title: string, extra: { detail?: string; data?: Record<string, unknown>; ms?: number } = {}): TraceEvent {
    const event: TraceEvent = {
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      runId: this.runId,
      iteration: this.iteration,
      agent,
      type,
      title,
      ...extra,
    };
    this.events.push(event);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // A failing listener (for example a closed browser stream) must not stop the run.
      }
    }
    return event;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** A trace that records nothing to disk, for tests and one-off scripts. */
export const memoryTrace = (runId = "test") => new Trace(runId);
