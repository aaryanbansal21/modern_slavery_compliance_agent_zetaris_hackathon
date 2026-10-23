// The model path through Nightshift, against a fake OpenAI-compatible server.
// Checks that every role routes to its configured model, that the evaluator
// can send work back and request tools, and that unusable output falls back
// to the deterministic policy instead of breaking the run.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: http.Server;
const seen: { model: string; role: string }[] = [];

function reply(model: string, content: string) {
  return JSON.stringify({ model: model === "meterless/deep" ? "nvidia/nemotron-fake" : `fake/${model}`, choices: [{ message: { content } }], usage: { total_tokens: 10 } });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "meterless/auto" }, { id: "meterless/deep" }] }));
      }
      const { model, messages } = JSON.parse(body) as { model: string; messages: { role: string; content: string }[] };
      const system = messages[0].content;
      const role = system.includes("evaluator") ? "evaluator" : system.includes("You plan") ? "planner" : system.includes("draft answers") ? "drafter" : "other";
      seen.push({ model, role });
      res.writeHead(200, { "content-type": "application/json" });
      if (role === "evaluator") {
        // Approve everything the gates allow, with a summary in the model's words.
        return res.end(reply(model, JSON.stringify({ verdict: "approve", issues: [], requestedTools: [], summary: "Claims match the cited evidence." })));
      }
      // Everything else returns something unusable, to exercise the fallback.
      return res.end(reply(model, "I cannot help with that."));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.AI_MODE = "nightshift";
  process.env.METERLESS_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.METERLESS_RUNTIME_TOKEN = "test-token";
  process.env.WORLD_NAMESPACE = "model-path";
});

afterAll(() => server.close());

describe("model path through Nightshift", () => {
  it("routes the evaluator to its own model and survives unusable output from other roles", async () => {
    const { runAssessment } = await import("../src/agents/orchestrator.ts");
    const { openWorld } = await import("../src/agents/world.ts");
    const { prepareData } = await import("../src/data/prepare.ts");
    prepareData();
    const summary = await runAssessment({ world: openWorld("model-path", "memory"), offlineAi: false, runId: "run-20261023-000009", writeFiles: false });
    expect(summary.aiMode).toBe("nightshift");
    expect(seen.some((s) => s.role === "evaluator" && s.model === "meterless/deep")).toBe(true);
    expect(summary.llmStats.byModel["nvidia/nemotron-fake"]).toBeGreaterThan(0);
    expect(summary.llmStats.fallbacks).toBeGreaterThan(0);
    // Gates still send unsupported drafts back even when the model approves.
    const q3 = summary.answers.find((a) => a.question.id === "Q3")!;
    expect(q3.history[0].verdict).toBe("revise");
    expect(q3.status).toBe("approved");
  });
});
