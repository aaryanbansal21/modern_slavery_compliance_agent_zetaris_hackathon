// Meterless Nightshift client, following the Meterless Runtime provider
// contract 0.90.0 (github.com/meterless/meterless docs/agent-ready/add-meterless-provider.md):
//
// - OpenAI-compatible, default base URL http://127.0.0.1:8088/v1; any pasted
//   URL (with or without scheme, /v1, /v1/chat/completions, /v1/models,
//   /healthz) normalizes to <host>/v1, never /v1/v1.
// - Authorization: Bearer <token> on every call. The runtime writes the token
//   to <stateDir>/proxy-token. The placeholder rt-local is rejected.
// - meterless-app: <stable app id> on every request, meterless-scope: user on chat.
// - Model ids are routing modes (meterless/auto, fast, deep, cheap, local,
//   fusion, meterless/<class>[.<disposition>]); unknown meterless/* ids are kept.
// - GET /v1/models decides status: 401/403 unauthorized, 200 online, else offline.
// - Auto Detect tries ports 8088, 8090, 8787, 11434 on 127.0.0.1, localhost, [::1].
// - 180 s timeout, because a model load can take minutes.
//
// NVIDIA models (Nemotron) are connected in Nightshift's Providers tab with
// your NVIDIA API key; this app then routes its evaluator to that route by id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripReasoning } from "./json.ts";

export type ProviderState = "online" | "unauthorized" | "offline";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs: number;
}

export function normalizeBaseUrl(input: string): string {
  let url = input.trim();
  if (!url) url = "http://127.0.0.1:8088/v1";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const u = new URL(url);
  return `${u.protocol}//${u.host}/v1`;
}

/** Find the runtime token: explicit value, explicit file, then known state-dir locations. */
export function resolveToken(explicit?: string, file?: string): { token?: string; from?: string } {
  if (explicit && explicit !== "rt-local") return { token: explicit, from: "METERLESS_RUNTIME_TOKEN" };
  const candidates = [
    file,
    path.join(os.homedir(), "Library", "Application Support", "Meterless", "proxy-token"),
    path.join(os.homedir(), "Library", "Application Support", "Nightshift", "proxy-token"),
    path.join(os.homedir(), "Library", "Application Support", "Meterless", "Nightshift", "proxy-token"),
    path.join(os.homedir(), ".meterless", "proxy-token"),
    path.join(os.homedir(), ".config", "meterless", "proxy-token"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "Meterless", "proxy-token") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Meterless", "proxy-token") : undefined,
  ].filter((x): x is string => !!x);
  for (const f of candidates) {
    try {
      const token = fs.readFileSync(f, "utf8").trim();
      if (token && token !== "rt-local") return { token, from: f };
    } catch {
      // not there
    }
  }
  return {};
}

export class NightshiftClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private token: string | undefined,
    private appId: string,
    private timeoutMs = 180_000,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private headers(chat: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "meterless-app": this.appId,
      ...(chat ? { "meterless-scope": "user" } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async status(): Promise<{ state: ProviderState; models: string[]; detail: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers(false), signal: AbortSignal.timeout(8_000) });
      if (res.status === 401 || res.status === 403) {
        return { state: "unauthorized", models: [], detail: `HTTP ${res.status}: paste the token from <stateDir>/proxy-token into METERLESS_RUNTIME_TOKEN` };
      }
      if (!res.ok) return { state: "offline", models: [], detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      return { state: "online", models, detail: `${models.length} routes available` };
    } catch (err) {
      return { state: "offline", models: [], detail: (err as Error).message };
    }
  }

  async chat(model: string, messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<ChatResult> {
    const t0 = performance.now();
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1800,
        stream: false,
        // Nemotron 3 reasoning models otherwise spend the whole token budget thinking and
        // return no answer. OpenAI-compatible servers ignore the field on models without it.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Nightshift unauthorized (HTTP ${res.status}). Check METERLESS_RUNTIME_TOKEN.`);
    if (!res.ok) throw new Error(`Nightshift HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
      usage?: ChatResult["usage"];
    };
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "";
    if (!stripReasoning(text)) throw new Error("Nightshift returned an empty completion");
    return { text, model: body.model ?? model, usage: body.usage, latencyMs: Math.round(performance.now() - t0) };
  }
}

/** The same OpenAI-compatible client serves Nightshift or NVIDIA's API directly; name the one in use. */
export const providerLabel = (baseUrl: string) => (/\.nvidia\.com/i.test(baseUrl) ? "NVIDIA API" : "Meterless Nightshift");

/** Auto Detect per the provider contract: first online or unauthorized hit wins. */
export async function autoDetect(appId: string, token?: string): Promise<{ baseUrl: string; state: ProviderState } | undefined> {
  for (const port of [8088, 8090, 8787, 11434]) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const client = new NightshiftClient(`http://${host}:${port}/v1`, token, appId, 5_000);
      const s = await client.status();
      if (s.state !== "offline") return { baseUrl: client.baseUrl, state: s.state };
    }
  }
  return undefined;
}
