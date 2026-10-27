import { describe, expect, it, vi } from "vitest";
import { normalizeZetarisResult, ZetarisSource } from "../src/data/zetaris.ts";
import { extractJson } from "../src/llm/json.ts";
import { NightshiftClient, normalizeBaseUrl } from "../src/llm/nightshift.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Zetaris client", () => {
  it("reads object rows and array rows with headers", () => {
    expect(normalizeZetarisResult({ data: [{ Line_ID: "L1", amount: 2 }] }).rows).toEqual([{ line_id: "L1", amount: 2 }]);
    const r = normalizeZetarisResult({ headers: [{ name: "a" }, { name: "b" }], data: [[1, "x"]] });
    expect(r.rows).toEqual([{ a: 1, b: "x" }]);
    expect(normalizeZetarisResult({ result: { data: [], headers: ["a"] } }).columns).toEqual(["a"]);
    expect(() => normalizeZetarisResult({ error: "Table not found" })).toThrow(/Table not found/);
  });

  it("logs in, then sends the bearer token, org ID and a request ID to the run-query route", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/auth/login")) return json({ idToken: "aaaaaaaa.bbbbbbbb.cccccccc" });
      return json({ headers: ["one"], data: [[1]] });
    }) as unknown as typeof fetch;
    const z = new ZetarisSource({ baseUrl: "http://localhost:3000", orgId: "42", apiKey: "", username: "u", password: "p", engineId: "", queryLimit: 100, timeoutMs: 5000, sourceHost: "" }, fake);
    const res = await z.query("SELECT 1 AS one");
    expect(res.rows).toEqual([{ one: 1 }]);
    const q = calls.find((c) => c.url.endsWith("/api/proxy/sql-editor/sqls/run-query"))!;
    const headers = q.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer aaaaaaaa.bbbbbbbb.cccccccc");
    expect(headers["X-Org-ID"]).toBe("42");
    expect(headers["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(q.init.body))).toEqual({ sql: "SELECT 1 AS one", limit: 100 });
  });

  it("waits out a Spark restart and retries, but fails fast on other query errors", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fake = (async () => (++n === 1 ? json({ msg: "org.apache.thrift.transport.TTransportException" }, 400) : json({ data: [{ one: 1 }] }))) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://localhost:3000", orgId: "42", apiKey: "k", username: "", password: "", engineId: "", queryLimit: 100, timeoutMs: 5000, sourceHost: "" };
    const pending = new ZetarisSource(cfg, fake).query("SELECT 1 AS one");
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await pending).rows).toEqual([{ one: 1 }]);
    vi.useRealTimers();
    const bad = (async () => json({ msg: "AnalysisException: Table not found" }, 400)) as unknown as typeof fetch;
    await expect(new ZetarisSource(cfg, bad).query("SELECT 1")).rejects.toThrow(/Table not found/);
  });
});

describe("Nightshift client (Meterless provider contract)", () => {
  it("normalizes pasted URLs to <host>/v1 and never /v1/v1", () => {
    expect(normalizeBaseUrl("127.0.0.1:8088")).toBe("http://127.0.0.1:8088/v1");
    expect(normalizeBaseUrl("http://localhost:8088/v1/chat/completions")).toBe("http://localhost:8088/v1");
    expect(normalizeBaseUrl("http://localhost:8088/v1/v1")).toBe("http://localhost:8088/v1");
    expect(normalizeBaseUrl("http://[::1]:8790/healthz")).toBe("http://[::1]:8790/v1");
  });

  it("reports unauthorized, not offline, on 401", async () => {
    const fake = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const c = new NightshiftClient("http://127.0.0.1:8088/v1", "wrong", "slavery-compliance-agent", 5000, fake);
    expect((await c.status()).state).toBe("unauthorized");
  });

  it("sends the app and scope headers and reports which model answered", async () => {
    let headers: Record<string, string> = {};
    let body: unknown;
    const fake = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      body = init.body;
      return json({ model: "nvidia/nemotron-test", choices: [{ message: { content: "<think>hmm</think>```json\n{\"ok\": true}\n```" } }] });
    }) as unknown as typeof fetch;
    const c = new NightshiftClient("http://127.0.0.1:8088", "tok", "slavery-compliance-agent", 5000, fake);
    const r = await c.chat("meterless/deep", [{ role: "user", content: "hi" }]);
    expect(headers["meterless-app"]).toBe("slavery-compliance-agent");
    expect(headers["meterless-scope"]).toBe("user");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(r.model).toBe("nvidia/nemotron-test");
    expect(JSON.parse(String(body)).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(extractJson(r.text)).toEqual({ ok: true });
  });
});
