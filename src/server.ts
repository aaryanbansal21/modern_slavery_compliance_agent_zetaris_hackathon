// Web app and API. Runs assessments, streams the reasoning trace to the
// browser, serves the World Model control plane, records human approvals,
// and serves the supplier portal export that Zetaris registers as a REST
// source.
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { config, ROOT } from "./config.ts";
import { DEFAULT_QUESTIONNAIRE, newRunId, runAssessment, runsDir } from "./agents/orchestrator.ts";
import { parseQuestionsPolicy, readQuestionnaireText } from "./agents/questionnaire.ts";
import type { RunSummary } from "./agents/types.ts";
import { ids, openWorld, recordApproval } from "./agents/world.ts";
import { openDataSource } from "./data/federated.ts";
import { DEMO_DIR, prepareData, readManifest } from "./data/prepare.ts";
import { TABLES, tableRef } from "./data/schema.ts";
import { NightshiftClient, resolveToken } from "./llm/nightshift.ts";
import { writeOutputs } from "./reporting/outputs.ts";
import type { TraceEvent } from "./trace/trace.ts";

const app = express();
app.use(express.json({ limit: "15mb" }));

const world = openWorld();
const uploadsDir = path.join(config.dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
let questionnaireFile = DEFAULT_QUESTIONNAIRE;

interface LiveRun {
  runId: string;
  status: "running" | "done" | "failed";
  events: TraceEvent[];
  listeners: Set<Response>;
  error?: string;
  summary?: RunSummary;
}
const runs = new Map<string, LiveRun>();
let active: LiveRun | undefined;

if (config.dataMode === "local" && !readManifest()) prepareData((m) => console.log(m));

// ------------------------------------------------------------- status

async function nightshiftStatus() {
  if (config.aiMode !== "nightshift") return { mode: "mock", state: "offline", detail: "AI_MODE=mock: deterministic policies, no model calls", models: [] as string[] };
  const { token, from } = resolveToken(config.nightshift.token, config.nightshift.tokenFile);
  const client = new NightshiftClient(config.nightshift.baseUrl, token, config.nightshift.appId, 8_000);
  const s = await client.status();
  return { mode: "nightshift", baseUrl: client.baseUrl, tokenFrom: from ?? "not found", ...s };
}

app.get("/api/status", async (_req, res) => {
  let data: { ok: boolean; mode: string; detail: string; label?: string } = { ok: false, mode: config.dataMode, detail: "" };
  try {
    const src = await openDataSource();
    const st = await src.status();
    data = { ...st, label: src.label };
    await src.close();
  } catch (err) {
    data.detail = (err as Error).message;
  }
  const ai = await nightshiftStatus();
  res.json({
    data,
    ai,
    roles: config.nightshift.models,
    tables: TABLES.map((t) => ({ ref: tableRef(t), system: t.system, description: t.description })),
    manifest: readManifest(),
    world: world.stats(),
    questionnaire: path.basename(questionnaireFile),
    running: active?.status === "running" ? active.runId : null,
  });
});

// ------------------------------------------------------------- runs

function broadcast(run: LiveRun, event: string, payload: unknown) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of run.listeners) res.write(line);
}

app.post("/api/runs", async (_req, res) => {
  if (active?.status === "running") return res.status(409).json({ error: "An assessment is already running.", runId: active.runId });
  const runId = newRunId();
  const run: LiveRun = { runId, status: "running", events: [], listeners: new Set() };
  runs.set(runId, run);
  active = run;
  res.json({ runId });
  try {
    const summary = await runAssessment({
      runId,
      questionnaireFile,
      world,
      onTrace: (e) => {
        run.events.push(e);
        broadcast(run, "trace", e);
      },
    });
    await writeOutputs(summary);
    run.summary = summary;
    run.status = "done";
    broadcast(run, "done", { runId });
  } catch (err) {
    run.status = "failed";
    run.error = (err as Error).message;
    console.error(err);
    broadcast(run, "failed", { runId, error: run.error });
  }
  for (const l of run.listeners) l.end();
  run.listeners.clear();
});

app.get("/api/runs/:id/events", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const e of run.events) res.write(`event: trace\ndata: ${JSON.stringify(e)}\n\n`);
  if (run.status !== "running") {
    res.write(`event: ${run.status === "done" ? "done" : "failed"}\ndata: ${JSON.stringify({ runId: run.runId, error: run.error })}\n\n`);
    return res.end();
  }
  run.listeners.add(res);
  req.on("close", () => run.listeners.delete(res));
});

function loadSummary(runId: string): RunSummary | undefined {
  const live = runs.get(runId)?.summary;
  if (live) return live;
  const file = path.join(runsDir(), runId, "run.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as RunSummary) : undefined;
}

function listRuns(): { runId: string; finished: boolean }[] {
  if (!fs.existsSync(runsDir())) return [];
  return fs.readdirSync(runsDir())
    .filter((d) => d.startsWith("run-"))
    .sort()
    .reverse()
    .map((runId) => ({ runId, finished: fs.existsSync(path.join(runsDir(), runId, "run.json")) }));
}

app.get("/api/runs", (_req, res) => res.json(listRuns()));

app.get("/api/runs/latest", (_req, res) => {
  const latest = listRuns().find((r) => r.finished);
  const summary = latest && loadSummary(latest.runId);
  return summary ? res.json(summary) : res.status(404).json({ error: "No finished assessment yet." });
});

app.get("/api/runs/:id", (req, res) => {
  const summary = loadSummary(req.params.id);
  if (summary) return res.json(summary);
  const run = runs.get(req.params.id);
  return run ? res.json({ runId: run.runId, status: run.status, error: run.error }) : res.status(404).json({ error: "Unknown run" });
});

app.get("/api/runs/:id/trace", (req, res) => {
  const file = path.join(runsDir(), req.params.id, "trace.jsonl");
  if (!fs.existsSync(file)) return res.status(404).json([]);
  res.json(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
});

const DOWNLOADS: Record<string, string> = {
  "answers.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "risk-register.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "evidence-pack.md": "text/markdown; charset=utf-8",
  "run.json": "application/json",
  "trace.jsonl": "application/x-ndjson",
};

app.get("/api/runs/:id/files/:name", (req, res) => {
  const name = String(req.params.name);
  const id = String(req.params.id);
  if (!DOWNLOADS[name] || !/^run-[0-9-]+$/.test(id)) return res.status(404).end();
  const file = path.join(runsDir(), id, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader("Content-Type", DOWNLOADS[name]);
  res.setHeader("Content-Disposition", `attachment; filename="${id}-${name}"`);
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------- questionnaire

app.post("/api/questionnaire", async (req: Request, res: Response) => {
  const { filename, contentBase64 } = req.body as { filename?: string; contentBase64?: string };
  if (!filename || !contentBase64) return res.status(400).json({ error: "Send filename and contentBase64." });
  const ext = path.extname(filename).toLowerCase();
  if (![".md", ".txt", ".docx"].includes(ext)) return res.status(400).json({ error: "Upload a .docx, .md or .txt questionnaire." });
  const file = path.join(uploadsDir, `questionnaire${ext}`);
  fs.writeFileSync(file, Buffer.from(contentBase64, "base64"));
  const text = await readQuestionnaireText(file);
  const parsed = parseQuestionsPolicy(text);
  if (!parsed.questions.length) return res.status(422).json({ error: "No questions found. Number each question (1., 2., ...) or end it with a question mark." });
  questionnaireFile = file;
  res.json({ file: path.basename(file), title: parsed.title, client: parsed.client, questions: parsed.questions });
});

app.post("/api/questionnaire/reset", (_req, res) => {
  questionnaireFile = DEFAULT_QUESTIONNAIRE;
  res.json({ file: path.basename(questionnaireFile) });
});

app.get("/api/questionnaire", async (_req, res) => {
  const text = await readQuestionnaireText(questionnaireFile);
  const parsed = parseQuestionsPolicy(text);
  res.json({ file: path.basename(questionnaireFile), ...parsed });
});

// ------------------------------------------------------------- World Model control plane

app.get("/api/world", (_req, res) => {
  const graph = world.view("graph");
  const types = [...new Set(graph.query({}).map((e) => e.type))].sort();
  res.json({
    stats: world.stats(),
    types: types.map((t) => ({ type: t, count: graph.query({ type: t }).length })),
    merges: world.mergeQueue(),
    audit: world.audit().slice(-60).reverse(),
  });
});

app.get("/api/world/entities", (req, res) => {
  const type = String(req.query.type ?? "");
  const q = String(req.query.q ?? "").toLowerCase();
  const list = world.view("graph").query({ type: type || undefined })
    .filter((e) => !q || (e.name ?? e.id).toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)))
    .slice(0, 200)
    .map((e) => ({ id: e.id, type: e.type, name: e.name, aliases: e.aliases, updatedAt: e.updatedAt, state: e.state }));
  res.json(list);
});

app.get("/api/world/entity", (req, res) => {
  const id = String(req.query.id ?? "");
  const entity = world.entity(id);
  if (!entity) return res.status(404).json({ error: "Unknown entity" });
  const graph = world.view("graph");
  const edges = graph.edgesOf(entity.id, { includeClosed: true }).map((r) => ({
    ...r, otherId: world.resolveId(r.from) === entity.id ? world.resolveId(r.to) : world.resolveId(r.from),
    otherName: world.entity(world.resolveId(r.from) === entity.id ? r.to : r.from)?.name,
    direction: world.resolveId(r.from) === entity.id ? "out" : "in",
  }));
  res.json({ entity, facts: world.view("facts").about(entity.id), edges });
});

app.get("/api/world/supplier/:supplierId/history", (req, res) => {
  res.json(world.view("facts").about(ids.supplier(req.params.supplierId), "risk_level"));
});

app.post("/api/world/merges/:id/:decision", async (req, res) => {
  const { id, decision } = req.params;
  try {
    if (decision === "approve") await world.approveMerge(id, "owner");
    else if (decision === "reject") await world.rejectMerge(id, "owner");
    else return res.status(400).json({ error: "Use approve or reject" });
    res.json({ ok: true, merges: world.mergeQueue() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/approvals", async (req, res) => {
  const { key, wording } = req.body as { key?: string; wording?: string };
  if (!key || !wording || wording.trim().length < 10) return res.status(400).json({ error: "Send the approval key and the approved wording." });
  await recordApproval(world, key, wording.trim(), "owner");
  res.json({ ok: true });
});

app.post("/api/world/rebuild", (_req, res) => {
  const ms = world.rebuild();
  res.json({ ms: Math.round(ms * 100) / 100, ...world.verifyReplay() });
});

// ------------------------------------------------------------- supplier portal (REST source for Zetaris)

app.get("/portal/api/declarations.json", (_req, res) => {
  res.sendFile(path.join(DEMO_DIR, "declarations.json"));
});

// ------------------------------------------------------------- static UI

app.use(express.static(path.join(ROOT, "web"), { extensions: ["html"] }));

const host = process.env.HOST ?? "127.0.0.1";
app.listen(config.port, host, () => {
  console.log(`Reasonable Steps running at http://${host === "0.0.0.0" ? "localhost" : host}:${config.port}`);
  console.log(`Data: ${config.dataMode}. AI: ${config.aiMode}. World Model namespace: ${world.namespace}.`);
});
