// Reasonable Steps web app. Plain JavaScript, no build step.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const aud = (v) => `AUD ${Math.round(Number(v) || 0).toLocaleString("en-AU")}`;

const STATUS = {
  approved: "Ready to send",
  needs_sign_off: "Needs your sign-off",
  needs_review: "Needs review",
  unresolved: "Unresolved",
};
const AGENTS = ["orchestrator", "parser", "planner", "executor", "zetaris", "resolver", "classifier", "adjudicator", "risk", "drafter", "evaluator", "nightshift", "world-model"];
const AGENT_LABEL = {
  orchestrator: "Orchestrator", parser: "Parser", planner: "Planner", executor: "Executor", zetaris: "Zetaris",
  resolver: "Resolver", classifier: "Classifier", adjudicator: "Adjudicator", risk: "Risk scorer", drafter: "Drafter",
  evaluator: "Evaluator", nightshift: "Nightshift", "world-model": "World Model",
};

const state = {
  view: "answers",
  status: null,
  questionnaire: null,
  summary: null,
  selected: "Q1",
  run: { id: null, events: [], live: false },
  traceAgents: new Set(AGENTS),
  openSupplier: null,
  resolved: new Set(),
  world: { type: "supplier", q: "", entity: null },
};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}

// ------------------------------------------------------------------ navigation

function show(view) {
  state.view = view;
  for (const t of $$(".tab")) t.setAttribute("aria-current", t.dataset.view === view ? "page" : "false");
  for (const v of $$(".view")) v.hidden = v.id !== `view-${view}`;
  render();
}

function render() {
  renderHeader();
  const fn = { answers: renderAnswers, suppliers: renderSuppliers, needs: renderNeeds, trace: renderTrace, world: renderWorld, sources: renderSources }[state.view];
  fn?.();
}

// ------------------------------------------------------------------ header

function renderHeader() {
  const s = state.status;
  const sum = state.summary;
  $("#brand-sub").textContent = sum ? `${sum.company} answering ${sum.client}` : "Modern slavery due diligence for suppliers";
  if (!s) return;
  const dataOk = s.data.ok;
  const aiMode = s.ai.mode;
  const aiState = aiMode === "mock" ? "warn" : s.ai.state === "online" ? "ok" : "bad";
  const evaluator = s.roles?.evaluator ?? "";
  $("#stack-status").innerHTML = `
    <span class="sys"><span class="dot ${dataOk ? "ok" : "bad"}"></span>${s.data.mode === "zetaris" ? "Zetaris data layer" : "Offline data (DuckDB)"}</span>
    <span class="sys"><span class="dot ${aiState}"></span>${aiMode === "mock" ? "AI offline (rule policies)" : `Nightshift ${esc(s.ai.state)}`}</span>
    ${aiMode === "nightshift" ? `<span class="sys"><span class="dot ${aiState}"></span>Evaluator: ${esc(evaluator)}</span>` : ""}
    <span class="sys"><span class="dot ok"></span>World Model: ${s.world.events} events</span>`;
  const n = openEscalations().length;
  const badge = $("#needs-count");
  badge.hidden = !n;
  badge.textContent = n;
  const btn = $("#run-btn");
  btn.disabled = state.run.live;
  btn.textContent = state.run.live ? "Running checks" : sum ? "Run the checks again" : "Check suppliers and draft answers";
}

function openEscalations() {
  return (state.summary?.escalations ?? []).filter((e) => e.status === "open" && !state.resolved.has(e.id));
}

// ------------------------------------------------------------------ answers

function citeChips(text) {
  return esc(text).replace(/\[((?:E-\d+)(?:,\s*E-\d+)*)\]/g, (_m, ids) =>
    ids.split(/,\s*/).map((id) => `<button type="button" class="cite" data-ev="${id}" aria-label="Open evidence ${id}">${id}</button>`).join(""));
}

function answerHtml(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((li) => `<li>${citeChips(li)}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^[-*•]\s+/.test(line)) { list.push(line.replace(/^[-*•]\s+/, "")); continue; }
    flush();
    out.push(line.startsWith("Proposed commitment") ? `<p class="proposal">${citeChips(line)}</p>` : `<p>${citeChips(line)}</p>`);
  }
  flush();
  return out.join("");
}

function renderAnswers() {
  const el = $("#view-answers");
  const sum = state.summary;
  const q = state.questionnaire;
  if (!sum) {
    el.innerHTML = `
      <div class="view-head"><div><h1>${esc(q?.title ?? "Supplier questionnaire")}</h1>
      <p>${esc(q?.client ?? "Your client")} has asked ${q?.questions?.length ?? 0} questions about modern slavery in your operations and supply chain.</p></div></div>
      <div class="empty">
        <h2>Answer it with evidence, not guesses</h2>
        <p>The agents read your ERP, your supplier portal and the public risk lists through Zetaris, check every purchase, and draft each answer with the evidence behind it. An evaluator checks every draft before you see it.</p>
        <button type="button" class="btn btn-primary" id="empty-run">Check suppliers and draft answers</button>
        <ol>${(q?.questions ?? []).map((x) => `<li>${esc(x.text)}</li>`).join("")}</ol>
      </div>`;
    $("#empty-run")?.addEventListener("click", startRun);
    return;
  }
  const answers = sum.answers;
  const current = answers.find((a) => a.question.id === state.selected) ?? answers[0];
  const ready = answers.filter((a) => a.status === "approved").length;
  el.innerHTML = `
    <div class="view-head">
      <div><h1>${esc(sum.questionnaireTitle)}</h1>
      <p>${ready} of ${answers.length} answers are ready to send. ${openEscalations().length ? `${openEscalations().length} items need you before you send.` : "Nothing needs you."} Purchases from ${esc(sum.coverage.periodFrom)} to ${esc(sum.coverage.periodTo)}.</p></div>
    </div>
    <div class="answers">
      <div class="rail">
        <ol>${answers.map((a) => `
          <li><button type="button" class="q-link" data-q="${a.question.id}" aria-current="${a.question.id === current.question.id}">
            <span class="q-num">${a.question.number}</span><span class="q-text">${esc(a.question.text)}</span><span class="mark ${a.status}" title="${STATUS[a.status]}"></span>
          </button></li>`).join("")}
        </ol>
        <div class="downloads">
          <h2>Download</h2>
          <a href="/api/runs/${sum.runId}/files/answers.docx">Completed questionnaire (Word)</a>
          <a href="/api/runs/${sum.runId}/files/risk-register.xlsx">Risk register and actions (Excel)</a>
          <a href="/api/runs/${sum.runId}/files/evidence-pack.md">Evidence pack with every query (Markdown)</a>
        </div>
        <div class="q-source">Questionnaire: ${esc(state.status?.questionnaire ?? "")}<br>
          <label class="btn btn-small" for="upload">Use a different questionnaire</label>
          <input type="file" id="upload" accept=".docx,.md,.txt" hidden>
        </div>
      </div>
      <article class="sheet" aria-labelledby="sheet-q">
        <h2 class="sheet-q" id="sheet-q">${current.question.number}. ${esc(current.question.text)}</h2>
        <div class="sheet-meta">
          <span class="status ${current.status}">${STATUS[current.status]}</span>
          <span>${current.iterations} draft${current.iterations === 1 ? "" : "s"}</span>
          <span>${current.citations.length} evidence references</span>
        </div>
        <div class="answer">${answerHtml(current.answer)}</div>
        ${historyHtml(current)}
      </article>
    </div>`;
  for (const b of $$(".q-link", el)) b.addEventListener("click", () => { state.selected = b.dataset.q; renderAnswers(); });
  $("#upload")?.addEventListener("change", uploadQuestionnaire);
}

function historyHtml(a) {
  const drafts = a.history ?? [];
  if (!drafts.length) return "";
  const rows = drafts.map((h, i) => {
    const last = i === drafts.length - 1;
    const label = `Draft ${i + 1}, iteration ${h.iteration}${h.drafter ? `, written by ${h.drafter}` : ""}`;
    let note;
    if (h.verdict === "revise") {
      note = `<div class="margin-note"><b>Sent back by the evaluator${h.reviewer ? ` (${esc(h.reviewer)})` : ""}</b>
        <ul>${h.issues.map((x) => `<li>${esc(x.detail)}</li>`).join("")}</ul>
        ${h.requestedTools.length ? `<div>Asked for: ${h.requestedTools.map(esc).join(", ")}</div>` : ""}</div>`;
    } else if (h.verdict === "escalate") {
      note = `<div class="margin-note esc"><b>Passed to you${h.reviewer ? `, reviewed by ${esc(h.reviewer)}` : ""}</b>${esc(h.summary || "Needs a person to decide.")}${h.issues.length ? `<ul>${h.issues.map((x) => `<li>${esc(x.detail)}</li>`).join("")}</ul>` : ""}</div>`;
    } else {
      note = `<div class="margin-note ok"><b>Approved${h.reviewer ? ` by ${esc(h.reviewer)}` : ""}</b>${esc(h.summary)}${h.notes.length ? `<ul>${h.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>`;
    }
    const body = last
      ? `<div class="draft-text muted">This is the answer shown above.</div>`
      : `<div class="draft-text">${citeChips(h.answer).replace(/\n+/g, "<br>")}</div>`;
    return `<div class="draft ${h.verdict === "revise" ? "sent-back" : ""}">
      <div><div class="draft-label">${esc(label)}${last ? " (current)" : ""}</div>${body}</div>
      ${note}</div>`;
  }).join("");
  return `<section class="history" aria-label="How this answer changed">
    <h2>How this answer changed</h2>
    <p>Each draft goes to the evaluator. Drafts it sent back are struck through, with its reasons in the margin.</p>
    ${rows}</section>`;
}

async function uploadQuestionnaire(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  try {
    const res = await api("/api/questionnaire", { method: "POST", body: JSON.stringify({ filename: file.name, contentBase64: btoa(binary) }) });
    state.questionnaire = res;
    state.status.questionnaire = res.file;
    toast(`Loaded ${res.questions.length} questions from ${file.name}. Run the checks to answer them.`);
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ evidence drawer

function sysClass(system) {
  if (/ERP/i.test(system)) return "sys-erp";
  if (/Object storage/i.test(system)) return "sys-obj";
  if (/portal/i.test(system)) return "sys-rest";
  return "";
}

function rowsTable(rows) {
  if (!rows?.length) return "";
  const cols = Object.keys(rows[0]).slice(0, 8);
  return `<table class="rows"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(0, 6).map((r) => `<tr>${cols.map((c) => `<td>${esc(String(r[c] ?? "").slice(0, 60))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function openEvidence(id) {
  const sum = state.summary;
  const e = sum?.evidence.find((x) => x.id === id);
  if (!e) return;
  const queries = e.queryIds.map((q) => sum.queries.find((x) => x.id === q)).filter(Boolean);
  $("#drawer-title").textContent = `${e.id}: ${e.title}`;
  $("#drawer-body").innerHTML = `
    <p class="ev-statement">${esc(e.statement)}</p>
    <div class="tags">
      ${e.systems.map((s) => `<span class="tag ${sysClass(s)}">${esc(s)}</span>`).join("") || `<span class="tag">Agent analysis in the World Model</span>`}
      <span class="tag">Iteration ${e.iteration}</span><span class="tag">${esc(e.tool)}</span>
      ${e.provisional ? `<span class="tag warn">Provisional: rests on an identity link awaiting your review</span>` : ""}
    </div>
    ${(e.sourceUrls ?? []).length ? `<p class="small">Reference: ${e.sourceUrls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, "").slice(0, 60))}</a>`).join(", ")}</p>` : ""}
    ${queries.map((q) => `
      <section class="query">
        <h3>${esc(q.id)}: ${esc(q.purpose)}</h3>
        <div class="small">${q.rowCount} rows in ${q.ms} ms from ${esc(q.systems.join(" + "))} via ${q.mode === "zetaris" ? "Zetaris" : "the offline stand-in"}</div>
        <div class="tags">${q.tables.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <pre class="sql">${esc(q.sql)}</pre>
        ${rowsTable(q.sample)}
      </section>`).join("")}`;
  $("#drawer").hidden = false;
  $("#scrim").hidden = false;
  $("#drawer-close").focus();
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
}

// ------------------------------------------------------------------ suppliers

function renderSuppliers() {
  const el = $("#view-suppliers");
  const sum = state.summary;
  if (!sum) {
    el.innerHTML = `<div class="empty"><h2>No assessment yet</h2><p>Run the checks to build your supplier risk register.</p></div>`;
    return;
  }
  const counts = { High: 0, Medium: 0, Low: 0, "Not flagged": 0 };
  sum.supplierRisks.forEach((r) => counts[r.level]++);
  el.innerHTML = `
    <div class="view-head"><div><h1>Supplier risk register</h1>
      <p>${counts.High} high, ${counts.Medium} medium, ${counts.Low} low, ${counts["Not flagged"]} not flagged across ${aud(sum.coverage.spendAud)} of spend. Levels describe the inherent risk of the goods, countries and sectors involved, not findings about a supplier's conduct.</p></div>
      <div class="actions-row"><a class="btn" href="/api/runs/${sum.runId}/files/risk-register.xlsx">Download register</a></div>
    </div>
    <table class="register">
      <thead><tr><th>Supplier</th><th>Risk</th><th class="num">Spend</th><th>Why</th><th>Declaration</th></tr></thead>
      <tbody>${sum.supplierRisks.map((r) => `
        <tr class="row" data-s="${r.supplierId}" tabindex="0" aria-expanded="${state.openSupplier === r.supplierId}">
          <td><b>${esc(r.name)}</b></td>
          <td><span class="level ${r.level.split(" ")[0]}">${esc(r.level)}</span></td>
          <td class="num">${aud(r.spendAud)}</td>
          <td>${r.reasons.length ? esc(r.reasons.join("; ")) : `<span class="muted">No indicators</span>`}${r.mitigations.length ? `<div class="small muted">Mitigations: ${esc(r.mitigations.join("; "))}</div>` : ""}</td>
          <td>${esc(r.declaration ?? "None")}</td>
        </tr>
        ${state.openSupplier === r.supplierId ? `<tr class="detail-row"><td colspan="5"><div id="sup-detail">${supplierDetail(r)}</div></td></tr>` : ""}`).join("")}
      </tbody>
    </table>`;
  for (const tr of $$("tr.row", el)) {
    const toggle = () => { state.openSupplier = state.openSupplier === tr.dataset.s ? null : tr.dataset.s; renderSuppliers(); loadRiskHistory(); };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  }
}

function supplierDetail(r) {
  const sum = state.summary;
  const findings = sum.findings.filter((f) => f.supplierId === r.supplierId);
  const actions = sum.actions.filter((a) => a.supplierId === r.supplierId);
  return `<div class="detail-grid">
    <div><h3>Findings</h3>${findings.length ? `<ul>${findings.map((f) => `<li><b>${esc(f.title)}</b><br>${esc(f.detail)} ${f.evidenceIds.map((id) => `<button type="button" class="cite" data-ev="${id}">${id}</button>`).join("")}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`}
      <h3>How the assessment changed</h3><div class="history-line" id="risk-history"><span class="muted">Loading from the World Model</span></div></div>
    <div><h3>Actions</h3>${actions.length ? `<ul>${actions.map((a) => `<li><b>${esc(a.title)}</b> (${esc(a.owner)}, within ${a.dueInDays} days)<br>${esc(a.detail)}</li>`).join("")}</ul>` : `<p class="muted">No actions.</p>`}</div>
  </div>`;
}

async function loadRiskHistory() {
  const id = state.openSupplier;
  if (!id) return;
  try {
    const facts = await api(`/api/world/supplier/${encodeURIComponent(id)}/history`);
    const el = $("#risk-history");
    if (!el) return;
    const run = state.summary.runId;
    const mine = facts.filter((f) => f.source.runId === run);
    const list = mine.length ? mine : facts;
    el.innerHTML = list.length
      ? list.map((f, i) => `${i ? `<span class="arrow" aria-hidden="true">then</span>` : ""}<span class="level ${String(f.value.level).split(" ")[0]}">Iteration ${f.value.iteration}: ${esc(f.value.level)}</span>`).join(" ")
        + `<div class="small muted" style="width:100%">Earlier levels are kept as superseded facts with provenance, not overwritten.</div>`
      : `<span class="muted">No risk facts recorded.</span>`;
  } catch {
    // history is optional
  }
}

// ------------------------------------------------------------------ needs you

function renderNeeds() {
  const el = $("#view-needs");
  const sum = state.summary;
  const items = sum?.escalations ?? [];
  if (!items.length) {
    el.innerHTML = `<div class="empty"><h2>Nothing needs you</h2><p>When an answer needs your sign-off, or the agents find something only a person can decide, it appears here.</p></div>`;
    return;
  }
  const kindLabel = { owner_approval: "Your sign-off", identity_review: "Confirm a supplier's identity", sanctions_review: "Sanctions review", supplier_info: "Supplier information", unresolved: "Review before sending" };
  el.innerHTML = `
    <div class="view-head"><div><h1>Needs you</h1><p>The agents stop here because these decisions belong to a person. After you act, run the checks again and the answers update.</p></div></div>
    <div class="needs-list">${items.map((e) => {
      const done = e.status !== "open" || state.resolved.has(e.id);
      let actions = "";
      if (!done && e.action?.kind === "approve_merge") {
        actions = `<div class="actions-row"><button type="button" class="btn btn-approve" data-merge="${esc(e.action.ref)}" data-id="${e.id}" data-d="approve">Yes, same company</button>
          <button type="button" class="btn" data-merge="${esc(e.action.ref)}" data-id="${e.id}" data-d="reject">No, keep separate</button></div>`;
      } else if (!done && e.action?.kind === "approve_wording") {
        actions = `<textarea id="w-${e.id}" aria-label="Commitment wording">${esc(e.action.proposal ?? "")}</textarea>
          <div class="actions-row"><button type="button" class="btn btn-approve" data-wording="${esc(e.action.ref)}" data-id="${e.id}">Approve this wording</button></div>`;
      } else if (!done) {
        actions = `<div class="actions-row"><button type="button" class="btn" data-ack="${e.id}">Mark as reviewed</button></div>`;
      }
      return `<article class="need ${done ? "resolved" : ""}">
        <div class="kind">${esc(kindLabel[e.type] ?? e.type)}${e.questionIds.length ? ` (affects ${e.questionIds.join(", ")})` : ""}</div>
        <h2>${esc(e.title)}</h2>
        <p>${esc(e.detail)}</p>
        ${done ? `<p><b>Done.</b> Run the checks again to update the answers.</p>` : actions}
      </article>`;
    }).join("")}</div>`;
  for (const b of $$("[data-merge]", el)) {
    b.addEventListener("click", async () => {
      try {
        await api(`/api/world/merges/${encodeURIComponent(b.dataset.merge)}/${b.dataset.d}`, { method: "POST" });
        state.resolved.add(b.dataset.id);
        toast(b.dataset.d === "approve" ? "Link saved in the World Model. The next run will use it." : "Kept separate. The next run will not link these records.");
        render();
      } catch (err) { toast(err.message); }
    });
  }
  for (const b of $$("[data-wording]", el)) {
    b.addEventListener("click", async () => {
      const wording = $(`#w-${b.dataset.id}`).value;
      try {
        await api("/api/approvals", { method: "POST", body: JSON.stringify({ key: b.dataset.wording, wording }) });
        state.resolved.add(b.dataset.id);
        toast("Wording approved and saved in the World Model. Run the checks again to update the answer.");
        render();
      } catch (err) { toast(err.message); }
    });
  }
  for (const b of $$("[data-ack]", el)) {
    b.addEventListener("click", () => { state.resolved.add(b.dataset.ack); render(); });
  }
}

// ------------------------------------------------------------------ trace

function renderTrace() {
  const el = $("#view-trace");
  const events = state.run.events;
  if (!events.length) {
    el.innerHTML = `<div class="empty"><h2>No trace yet</h2><p>Run the checks to watch the planner, the executor's Zetaris queries, the drafter and the evaluator work in real time.</p></div>`;
    return;
  }
  const t0 = Date.parse(events[0].at);
  const shown = events.filter((e) => state.traceAgents.has(e.agent));
  const byIter = new Map();
  for (const e of shown) byIter.set(e.iteration, [...(byIter.get(e.iteration) ?? []), e]);
  const present = AGENTS.filter((a) => events.some((e) => e.agent === a));
  const queries = events.filter((e) => e.type === "query").length;
  const modelCalls = events.filter((e) => e.type === "llm" && e.data?.provider === "nightshift").length;
  const policyCalls = events.filter((e) => (e.type === "llm" || e.type === "warning") && e.data?.provider === "policy").length;
  const verdicts = events.filter((e) => e.type === "verdict");
  el.innerHTML = `
    <div class="view-head"><div><h1>Agent trace</h1>
      <p>${events.length} events: ${queries} federated queries, ${modelCalls} model calls through Nightshift${policyCalls ? `, ${policyCalls} rule-based decisions` : ""}, ${verdicts.length} evaluator verdicts (${verdicts.filter((v) => v.data?.verdict === "revise").length} sent back).</p></div>
      ${state.run.id ? `<div class="actions-row"><a class="btn" href="/api/runs/${state.run.id}/files/trace.jsonl">Download trace</a></div>` : ""}
    </div>
    ${state.run.live ? `<div class="live-banner"><span class="pulse" aria-hidden="true"></span>Running. Events appear as the agents work.</div>` : ""}
    <div class="trace-layout">
      <div class="filters"><h2>Show</h2>${present.map((a) => `<label><input type="checkbox" data-agent="${a}" ${state.traceAgents.has(a) ? "checked" : ""}> ${AGENT_LABEL[a]}</label>`).join("")}</div>
      <div class="trace" id="trace-list">${[...byIter.entries()].map(([it, list]) => `
        <div class="iter-head">${it === 0 ? "Setup" : `Iteration ${it}`}</div>
        ${list.map((e) => traceRow(e, t0)).join("")}`).join("")}
      </div>
    </div>`;
  for (const cb of $$("[data-agent]", el)) {
    cb.addEventListener("change", () => {
      if (cb.checked) state.traceAgents.add(cb.dataset.agent);
      else state.traceAgents.delete(cb.dataset.agent);
      renderTrace();
    });
  }
  for (const b of $$("[data-sql]", el)) {
    b.addEventListener("click", () => {
      const pre = b.nextElementSibling;
      pre.hidden = !pre.hidden;
      b.textContent = pre.hidden ? "Show SQL" : "Hide SQL";
    });
  }
}

function traceRow(e, t0) {
  const secs = Math.max(0, (Date.parse(e.at) - t0) / 1000);
  const verdict = e.type === "verdict" ? ` verdict-${e.data?.verdict}` : "";
  let detail = e.detail ? `<div class="detail">${esc(e.detail.length > 420 ? `${e.detail.slice(0, 420)}...` : e.detail)}</div>` : "";
  if (e.type === "llm" && e.data?.requestedModel) {
    detail = `<div class="detail">Route ${esc(e.data.requestedModel)}, answered by ${esc(e.data.model)}${e.data.cached ? " (cache)" : ""}${e.ms ? ` in ${(e.ms / 1000).toFixed(1)} s` : ""}</div>`;
  }
  const sql = e.type === "query" && e.data?.sql ? `<button type="button" class="btn btn-small sql-toggle" data-sql>Show SQL</button><pre class="sql" hidden>${esc(e.data.sql)}</pre>` : "";
  return `<div class="ev type-${e.type}${verdict}">
    <div class="t">${secs.toFixed(1)}s</div>
    <div class="who ${e.agent}">${AGENT_LABEL[e.agent] ?? esc(e.agent)}</div>
    <div><div class="title">${esc(e.title)}</div>${detail}${sql}</div>
  </div>`;
}

// ------------------------------------------------------------------ world model

async function renderWorld() {
  const el = $("#view-world");
  let w;
  try {
    w = await api("/api/world");
  } catch (err) {
    el.innerHTML = `<div class="empty"><h2>World Model unavailable</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  const s = w.stats;
  const entities = await api(`/api/world/entities?type=${encodeURIComponent(state.world.type)}&q=${encodeURIComponent(state.world.q)}`);
  el.innerHTML = `
    <div class="view-head"><div><h1>World Model</h1>
      <p>The shared state every agent reads and writes, built on the Meterless World Model engine: an append-only event log with stable IDs, provenance on every write, bitemporal relationships and a human review queue for merges. It persists between runs.</p></div>
      <div class="actions-row"><button type="button" class="btn" id="rebuild">Rebuild views from the log</button></div>
    </div>
    <div class="strip">
      <div><b>${s.events}</b><span>events</span></div><div><b>${s.entities}</b><span>entities</span></div>
      <div><b>${s.openRelationships}</b><span>open relationships</span></div><div><b>${s.relationships - s.openRelationships}</b><span>closed (history)</span></div>
      <div><b>${s.facts}</b><span>facts</span></div><div><b>${s.aliases}</b><span>merged identities</span></div><div><b>${s.pendingMerges}</b><span>merges awaiting review</span></div>
    </div>
    <div class="world-layout">
      <div>
        <div class="panel"><h2>Entity types</h2><div class="type-list">${w.types.map((t) => `<button type="button" data-type="${esc(t.type)}" aria-current="${t.type === state.world.type}"><span>${esc(t.type)}</span><span class="num">${t.count}</span></button>`).join("")}</div></div>
        <div class="panel"><h2>Merge review queue</h2>${w.merges.length ? w.merges.map((m) => `
          <div class="fact"><b>${esc(m.leftName)}</b> ~ <b>${esc(m.rightName)}</b><div class="small muted">Similarity ${m.similarity.toFixed(3)}. ${esc(m.status)}${m.resolvedBy ? ` by ${esc(m.resolvedBy)}` : ""}</div>
          ${m.status === "pending" ? `<div class="actions-row" style="margin-top:6px"><button type="button" class="btn btn-small btn-approve" data-m="${m.id}" data-d="approve">Approve merge</button><button type="button" class="btn btn-small" data-m="${m.id}" data-d="reject">Reject</button></div>` : ""}</div>`).join("") : `<p class="muted small">No proposals.</p>`}</div>
      </div>
      <div>
        <div class="panel">
          <h2>${esc(state.world.type)} entities</h2>
          <input class="search" id="wsearch" type="search" placeholder="Search names and aliases" value="${esc(state.world.q)}" aria-label="Search entities">
          <div class="entity-list">${entities.map((e) => `<button type="button" data-e="${esc(e.id)}"><div>${esc(e.name ?? e.id)}</div><div class="id">${esc(e.id)}${e.aliases.length > 1 ? `; also known as ${esc(e.aliases.filter((a) => a !== e.name).join(", "))}` : ""}</div></button>`).join("") || `<p class="muted small">No entities of this type yet.</p>`}</div>
        </div>
        <div class="panel" id="entity-panel" ${state.world.entity ? "" : "hidden"}></div>
        <div class="panel"><h2>Audit log (latest first)</h2><table class="audit"><tbody>${w.audit.slice(0, 25).map((a) => `<tr><td class="num muted">${a.seq}</td><td>${esc(a.action)}</td><td class="muted">${esc(a.actor)}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table></div>
      </div>
    </div>`;
  for (const b of $$("[data-type]", el)) b.addEventListener("click", () => { state.world.type = b.dataset.type; state.world.entity = null; renderWorld(); });
  for (const b of $$("[data-e]", el)) b.addEventListener("click", () => { state.world.entity = b.dataset.e; showEntity(); });
  $("#wsearch")?.addEventListener("change", (e) => { state.world.q = e.target.value; renderWorld(); });
  $("#rebuild")?.addEventListener("click", async () => {
    const r = await api("/api/world/rebuild", { method: "POST" });
    toast(`Rebuilt all views from ${r.events} events in ${r.ms} ms. Replay ${r.ok ? "matches" : "does not match"} the current state.`);
  });
  for (const b of $$("[data-m]", el)) {
    b.addEventListener("click", async () => {
      await api(`/api/world/merges/${encodeURIComponent(b.dataset.m)}/${b.dataset.d}`, { method: "POST" });
      toast(b.dataset.d === "approve" ? "Merge approved. Run the checks again to use it." : "Merge rejected.");
      renderWorld();
    });
  }
  if (state.world.entity) showEntity();
}

async function showEntity() {
  const panel = $("#entity-panel");
  if (!panel) return;
  try {
    const d = await api(`/api/world/entity?id=${encodeURIComponent(state.world.entity)}`);
    const attrs = Object.entries(d.entity.attrs).filter(([, v]) => v !== undefined && v !== null && v !== "");
    panel.hidden = false;
    panel.innerHTML = `<h2>${esc(d.entity.name ?? d.entity.id)}</h2>
      <dl class="kv"><dt>ID</dt><dd>${esc(d.entity.id)}</dd><dt>Type</dt><dd>${esc(d.entity.type)}</dd>
      <dt>Provenance</dt><dd>${esc(d.entity.source.kind)}${d.entity.source.ref ? ` (${esc(d.entity.source.ref)})` : ""} at ${esc(d.entity.source.at)}</dd>
      ${d.entity.aliases.length ? `<dt>Aliases</dt><dd>${esc(d.entity.aliases.join("; "))}</dd>` : ""}
      ${attrs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>
      ${d.facts.length ? `<h2 style="margin-top:14px">Facts (oldest first)</h2>${d.facts.map((f) => `<div class="fact ${f.supersededBy ? "superseded" : ""}"><b>${esc(f.predicate)}</b>: <span class="fv">${esc(typeof f.value === "object" ? (f.value.level ? `${f.value.level} (iteration ${f.value.iteration})` : JSON.stringify(f.value).slice(0, 200)) : f.value)}</span><div class="small muted">${esc(f.source.kind)} at ${esc(f.assertedAt)}${f.supersededBy ? ", superseded" : ", current"}</div></div>`).join("")}` : ""}
      ${d.edges.length ? `<h2 style="margin-top:14px">Relationships</h2>${d.edges.slice(0, 40).map((r) => `<div class="fact ${r.validTo ? "superseded" : ""}">${r.direction === "out" ? "" : "&larr; "}<b>${esc(r.type)}</b> ${r.direction === "out" ? "&rarr; " : ""}${esc(r.otherName ?? r.otherId)}<div class="small muted">valid from ${esc(r.validFrom)}${r.validTo ? ` to ${esc(r.validTo)}` : ""}${r.attrs?.score ? `, score ${r.attrs.score}` : ""}</div></div>`).join("")}` : ""}`;
  } catch (err) {
    panel.hidden = false;
    panel.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ sources

function renderSources() {
  const el = $("#view-sources");
  const s = state.status;
  if (!s) return;
  const sum = state.summary;
  const bySystem = new Map();
  for (const t of s.tables) bySystem.set(t.system, [...(bySystem.get(t.system) ?? []), t]);
  const roles = Object.entries(s.roles ?? {});
  const answered = sum?.llmStats?.byModel ?? {};
  el.innerHTML = `
    <div class="view-head"><div><h1>Data and AI</h1><p>Where the evidence comes from and which models did the work.</p></div></div>
    <div class="sources-grid">
      <div class="panel">
        <h2>Data layer: ${s.data.mode === "zetaris" ? "Zetaris" : "offline stand-in"}</h2>
        <p class="flow">${esc(s.data.detail)}</p>
        ${s.manifest?.sanctions?.source === "TEST_FIXTURE" ? `<p class="note">The sanctions list loaded locally is a test fixture with synthetic names. Run <code>npm run fetch:data</code> to load the DFAT Consolidated List.</p>` : ""}
        <p class="flow">Every query names its tables, and Zetaris joins across these systems in one statement, so only the answer rows reach the agents.</p>
        ${[...bySystem.entries()].map(([sys, list]) => `<h3 class="small" style="margin:14px 0 6px">${esc(sys)}</h3>
          <table class="audit"><tbody>${list.map((t) => `<tr><td><b>${esc(t.ref)}</b></td><td>${esc(t.description)}</td></tr>`).join("")}</tbody></table>`).join("")}
      </div>
      <div>
        <div class="panel">
          <h2>AI: ${s.ai.mode === "mock" ? "offline rule policies" : "Meterless Nightshift"}</h2>
          <p class="flow">${s.ai.mode === "mock" ? "AI_MODE=mock. Each agent runs its deterministic policy. Set AI_MODE=nightshift to use models." : `${esc(s.ai.baseUrl)}: ${esc(s.ai.state)}. ${esc(s.ai.detail ?? "")}`}</p>
          <table class="audit"><tbody>${roles.map(([role, model]) => `<tr><td>${esc(role)}</td><td><b>${esc(model)}</b></td></tr>`).join("")}</tbody></table>
          ${Object.keys(answered).length ? `<h3 class="small" style="margin:14px 0 6px">Models that answered in the last run</h3><table class="audit"><tbody>${Object.entries(answered).map(([m, n]) => `<tr><td>${esc(m)}</td><td class="num">${n} calls</td></tr>`).join("")}</tbody></table>` : ""}
          ${(s.ai.models ?? []).length ? `<h3 class="small" style="margin:14px 0 6px">Routes Nightshift offers</h3><p class="small">${s.ai.models.map(esc).join(", ")}</p>` : ""}
        </div>
        ${sum ? `<div class="panel"><h2>Last run</h2><dl class="kv">
          <dt>Run</dt><dd>${esc(sum.runId)}</dd><dt>Iterations</dt><dd>${sum.iterations}</dd>
          <dt>Queries</dt><dd>${sum.queries.length}</dd><dt>Evidence</dt><dd>${sum.evidence.length} items</dd>
          <dt>Lines screened</dt><dd>${sum.coverage.lines} (${sum.coverage.linesWithOrigin} with origin)</dd>
          <dt>Sanctions</dt><dd>${sum.coverage.namesScreened} names, scope ${esc(sum.coverage.sanctionsScope)}</dd></dl></div>` : ""}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ runs

async function startRun() {
  if (state.run.live) return;
  try {
    const { runId } = await api("/api/runs", { method: "POST" });
    state.run = { id: runId, events: [], live: true };
    $("#run-state").textContent = "Starting";
    show("trace");
    const es = new EventSource(`/api/runs/${runId}/events`);
    let pending = false;
    es.addEventListener("trace", (msg) => {
      const e = JSON.parse(msg.data);
      state.run.events.push(e);
      $("#run-state").textContent = `Iteration ${e.iteration || 1}: ${e.title.slice(0, 60)}`;
      if (state.view === "trace" && !pending) {
        pending = true;
        requestAnimationFrame(() => { pending = false; renderTrace(); });
      }
    });
    es.addEventListener("done", async () => {
      es.close();
      state.run.live = false;
      state.summary = await api(`/api/runs/${runId}`);
      state.resolved.clear();
      state.status = await api("/api/status");
      const ready = state.summary.answers.filter((a) => a.status === "approved").length;
      $("#run-state").textContent = "";
      toast(`Finished in ${state.summary.iterations} iterations: ${ready} of ${state.summary.answers.length} answers ready, ${openEscalations().length} items need you.`);
      render();
    });
    es.addEventListener("failed", (msg) => {
      es.close();
      state.run.live = false;
      const { error } = JSON.parse(msg.data);
      $("#run-state").textContent = "";
      toast(`The run stopped: ${error}`);
      render();
    });
    render();
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  for (const t of $$(".tab")) t.addEventListener("click", () => show(t.dataset.view));
  $("#run-btn").addEventListener("click", startRun);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  document.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".cite");
    if (chip) { e.stopPropagation(); openEvidence(chip.dataset.ev); }
  });

  try {
    [state.status, state.questionnaire] = await Promise.all([api("/api/status"), api("/api/questionnaire")]);
  } catch (err) {
    toast(`Cannot reach the server: ${err.message}`);
  }
  try {
    state.summary = await api("/api/runs/latest");
    state.run.id = state.summary.runId;
    state.run.events = await api(`/api/runs/${state.summary.runId}/trace`);
  } catch {
    // no runs yet
  }
  if (state.status?.running) {
    state.run = { id: state.status.running, events: [], live: false };
  }
  const fromHash = location.hash.replace("#", "");
  show(["answers", "suppliers", "needs", "trace", "world", "sources"].includes(fromHash) ? fromHash : "answers");
}

boot();
