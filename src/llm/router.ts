// Model router. Each agent role maps to a Nightshift routing id, so the
// drafter and the evaluator can run on different model families (the
// evaluator defaults to an NVIDIA Nemotron route), and the work is never
// graded by the model that wrote it. Every call is logged with the role, the
// requested route and the model that actually answered.
//
// Outputs are JSON validated with zod. Invalid output gets one repair
// attempt; after that the agent's deterministic policy takes over and the
// trace says so. In AI_MODE=mock no model is called and every role runs its
// deterministic policy, which keeps tests and offline runs reproducible.
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { config } from "../config.ts";
import { sha256Hex } from "../engines/world-model/stableIds.ts";
import type { AgentName, Trace } from "../trace/trace.ts";
import { extractJson } from "./json.ts";
import { NightshiftClient, resolveToken, type ChatMessage } from "./nightshift.ts";

export type Role = "parser" | "planner" | "classifier" | "resolver" | "adjudicator" | "drafter" | "evaluator";

export interface CallMeta {
  role: Role;
  provider: "nightshift" | "policy";
  requestedModel: string;
  model: string;
  latencyMs: number;
  cached: boolean;
  fallback: boolean;
  reason?: string;
  tokens?: number;
}

export interface LlmStats {
  calls: number;
  byModel: Record<string, number>;
  byRole: Record<string, string>;
  fallbacks: number;
  cacheHits: number;
}

const ROLE_AGENT: Record<Role, AgentName> = {
  parser: "parser", planner: "planner", classifier: "classifier", resolver: "resolver",
  adjudicator: "adjudicator", drafter: "drafter", evaluator: "evaluator",
};

export class LlmRouter {
  readonly stats: LlmStats = { calls: 0, byModel: {}, byRole: {}, fallbacks: 0, cacheHits: 0 };
  private client?: NightshiftClient;
  private active = 0;
  private waiting: (() => void)[] = [];
  private cacheDir: string;
  readonly offline: boolean;

  constructor(private trace?: Trace, opts: { offline?: boolean } = {}) {
    this.offline = opts.offline ?? config.aiMode !== "nightshift";
    this.cacheDir = path.join(config.dataDir, "llm-cache");
    if (!this.offline) {
      const { token } = resolveToken(config.nightshift.token, config.nightshift.tokenFile);
      this.client = new NightshiftClient(config.nightshift.baseUrl, token, config.nightshift.appId, config.nightshift.timeoutMs);
    }
  }

  attach(trace: Trace) {
    this.trace = trace;
  }

  modelFor(role: Role): string {
    const m = config.nightshift.models;
    switch (role) {
      case "parser": return m.parser;
      case "planner": return m.planner;
      case "classifier":
      case "resolver": return m.classifier;
      case "drafter": return m.drafter;
      case "evaluator":
      case "adjudicator": return m.evaluator;
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= config.nightshift.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private cacheGet(key: string): { text: string; model: string } | undefined {
    if (process.env.LLM_CACHE === "off") return undefined;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.cacheDir, `${key}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  private cachePut(key: string, value: { text: string; model: string }) {
    if (process.env.LLM_CACHE === "off") return;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(this.cacheDir, `${key}.json`), JSON.stringify(value));
  }

  /**
   * Ask a role for JSON matching `schema`. `policy` is the deterministic
   * behaviour used offline, and as the fallback when the model fails.
   */
  async json<T>(
    role: Role,
    task: string,
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    policy: () => T,
    opts: { temperature?: number; maxTokens?: number } = {},
  ): Promise<{ value: T; meta: CallMeta }> {
    const requestedModel = this.modelFor(role);
    const agent = ROLE_AGENT[role];
    // MODEL_<ROLE>=policy keeps one role on its deterministic policy while the others call models.
    const usePolicy = this.offline || !this.client || requestedModel === "policy";
    this.stats.byRole[role] = usePolicy ? "policy" : requestedModel;

    if (usePolicy) {
      const value = policy();
      const meta: CallMeta = { role, provider: "policy", requestedModel, model: "deterministic policy", latencyMs: 0, cached: false, fallback: false, reason: this.offline ? "AI_MODE=mock" : `route for ${role} set to policy` };
      this.trace?.log(agent, "llm", `${task} (deterministic policy)`, { data: { ...meta } });
      return { value, meta };
    }

    const key = sha256Hex(JSON.stringify({ requestedModel, messages, t: opts.temperature ?? 0.2 }));
    let attemptMessages = messages;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cached = attempt === 0 ? this.cacheGet(key) : undefined;
        const t0 = performance.now();
        const res = cached
          ? { text: cached.text, model: cached.model, latencyMs: 0, usage: undefined }
          : await this.slot(() => this.client!.chat(requestedModel, attemptMessages, opts));
        const value = schema.parse(extractJson(res.text));
        if (!cached && attempt === 0) this.cachePut(key, { text: res.text, model: res.model });
        this.stats.calls++;
        this.stats.byModel[res.model] = (this.stats.byModel[res.model] ?? 0) + 1;
        if (cached) this.stats.cacheHits++;
        const meta: CallMeta = {
          role, provider: "nightshift", requestedModel, model: res.model, latencyMs: Math.round(cached ? 0 : performance.now() - t0),
          cached: !!cached, fallback: false, tokens: res.usage?.total_tokens,
        };
        this.trace?.log(agent, "llm", `${task}`, {
          detail: `${requestedModel} answered by ${res.model}${cached ? " (cache hit)" : ""}`,
          data: { ...meta }, ms: meta.latencyMs,
        });
        return { value, meta };
      } catch (err) {
        lastError = (err as Error).message.slice(0, 300);
        if (attempt === 0 && /JSON|parse|Expected|Required|invalid/i.test(lastError)) {
          attemptMessages = [
            ...messages,
            { role: "user", content: `Your last reply could not be used: ${lastError}. Reply again with only the JSON object that matches the requested format.` },
          ];
          continue;
        }
        break;
      }
    }
    this.stats.fallbacks++;
    const value = policy();
    const meta: CallMeta = { role, provider: "policy", requestedModel, model: "deterministic policy", latencyMs: 0, cached: false, fallback: true, reason: lastError };
    this.trace?.log(agent, "warning", `${task}: model output unusable, deterministic policy used`, { detail: lastError, data: { ...meta } });
    return { value, meta };
  }
}
