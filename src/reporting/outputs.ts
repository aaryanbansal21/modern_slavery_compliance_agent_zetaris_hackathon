// Deliverables for the business owner:
//   answers.docx         completed questionnaire, ready to review and send
//   risk-register.xlsx   supplier risk, findings, actions, evidence, queries
//   evidence-pack.md     every claim traced to evidence, every evidence item to SQL
import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { runsDir } from "../agents/orchestrator.ts";
import { config } from "../config.ts";
import { providerLabel } from "../llm/nightshift.ts";
import type { RunSummary } from "../agents/types.ts";

const STATUS_LABEL: Record<string, string> = {
  approved: "Ready to send",
  needs_sign_off: "Needs owner sign-off",
  needs_review: "Needs review",
  unresolved: "Unresolved",
};

const audFmt = (v: number) => `AUD ${Math.round(v).toLocaleString("en-AU")}`;

export async function writeOutputs(summary: RunSummary, dir = path.join(runsDir(), summary.runId)): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    path.join(dir, "answers.docx"),
    path.join(dir, "risk-register.xlsx"),
    path.join(dir, "evidence-pack.md"),
  ];
  fs.writeFileSync(files[0], await answersDocx(summary));
  await riskWorkbook(summary).xlsx.writeFile(files[1]);
  fs.writeFileSync(files[2], evidencePack(summary));
  return files;
}

// ------------------------------------------------------------------ docx

function para(text: string, opts: { bold?: boolean; size?: number; color?: string; italics?: boolean; spacingAfter?: number } = {}) {
  return new Paragraph({
    spacing: { after: opts.spacingAfter ?? 120 },
    children: [new TextRun({ text, bold: opts.bold, size: opts.size, color: opts.color, italics: opts.italics, font: "Calibri" })],
  });
}

export async function answersDocx(s: RunSummary): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: s.questionnaireTitle, font: "Calibri" })] }));
  children.push(para(`Response from ${s.company}`, { bold: true, size: 24 }));
  children.push(para(`Prepared ${s.finishedAt.slice(0, 10)}. Covers purchases from ${s.coverage.periodFrom} to ${s.coverage.periodTo}. Evidence references in square brackets point to the evidence appendix.`, { size: 20, color: "555555" }));

  const open = s.escalations.filter((e) => e.status === "open" && e.blocking);
  if (open.length) {
    children.push(para("Before sending: items that need a person", { bold: true, size: 22, color: "9A3412" }));
    for (const e of open) children.push(para(`• ${e.title}. ${e.detail}`, { size: 20 }));
  }

  for (const a of s.answers) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 }, children: [new TextRun({ text: `${a.question.number}. ${a.question.text}`, font: "Calibri" })] }));
    children.push(para(`Status: ${STATUS_LABEL[a.status]}`, { italics: true, size: 18, color: a.status === "approved" ? "166534" : "9A3412" }));
    for (const raw of a.answer.split(/\n+/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[-*•]\s+/.test(line)) {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: [new TextRun({ text: line.replace(/^[-*•]\s+/, ""), size: 22, font: "Calibri" })] }));
      } else children.push(para(line, { size: 22 }));
    }
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360 }, children: [new TextRun({ text: "Evidence appendix", font: "Calibri" })] }));
  const cited = new Set(s.answers.flatMap((a) => a.citations));
  const rows = s.evidence.filter((e) => cited.has(e.id));
  const header = new TableRow({
    tableHeader: true,
    children: ["Ref", "Evidence", "Source systems"].map((h) => new TableCell({
      shading: { type: ShadingType.CLEAR, color: "auto", fill: "E7EDF3" },
      children: [para(h, { bold: true, size: 18, spacingAfter: 40 })],
    })),
  });
  const border = { style: BorderStyle.SINGLE, size: 2, color: "D0D7DE" };
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [header, ...rows.map((e) => new TableRow({
      children: [
        new TableCell({ width: { size: 8, type: WidthType.PERCENTAGE }, children: [para(e.id, { size: 18, spacingAfter: 40 })] }),
        new TableCell({ width: { size: 64, type: WidthType.PERCENTAGE }, children: [para(e.statement, { size: 18, spacingAfter: 40 })] }),
        new TableCell({ width: { size: 28, type: WidthType.PERCENTAGE }, children: [para(`${e.systems.join(", ") || "Agent analysis"}${e.queryIds.length ? ` (queries ${e.queryIds.join(", ")})` : ""}`, { size: 16, spacingAfter: 40 })] }),
      ],
    }))],
  }));
  children.push(para(""));
  children.push(para("Reference lists: US Department of Labor, List of Goods Produced by Child Labor or Forced Labor (2024). Australian Sanctions Consolidated List (DFAT). Listings describe inherent risk for a product and country; they are not findings about individual suppliers.", { size: 16, color: "555555" }));

  const doc = new Document({
    creator: s.company,
    title: s.questionnaireTitle,
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [{ properties: {}, children: children as Paragraph[] }],
  });
  void AlignmentType;
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ xlsx

export function riskWorkbook(s: RunSummary): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = s.company;
  wb.created = new Date(s.finishedAt);
  const style = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7EDF3" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.eachRow((row) => (row.alignment = { vertical: "top", wrapText: true }));
  };

  const risk = wb.addWorksheet("Supplier risk");
  risk.columns = [
    { header: "Supplier", key: "name", width: 34 }, { header: "Risk", key: "level", width: 12 }, { header: "Score", key: "score", width: 8 },
    { header: "Spend (AUD)", key: "spend", width: 14 }, { header: "Why", key: "reasons", width: 70 }, { header: "Mitigations", key: "mit", width: 40 },
    { header: "Declaration", key: "decl", width: 22 }, { header: "Evidence", key: "ev", width: 18 },
  ];
  for (const r of s.supplierRisks) {
    const row = risk.addRow({ name: r.name, level: r.level, score: r.score, spend: Math.round(r.spendAud), reasons: r.reasons.join("; "), mit: r.mitigations.join("; "), decl: r.declaration ?? "None", ev: r.evidenceIds.join(", ") });
    const fill = r.level === "High" ? "FFFDE2E1" : r.level === "Medium" ? "FFFEF3C7" : r.level === "Low" ? "FFECFDF5" : undefined;
    if (fill) row.getCell("level").fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  risk.getColumn("spend").numFmt = "#,##0";
  style(risk);

  const actions = wb.addWorksheet("Actions");
  actions.columns = [
    { header: "Priority", key: "p", width: 9 }, { header: "Action", key: "t", width: 40 }, { header: "Detail", key: "d", width: 80 },
    { header: "Owner", key: "o", width: 18 }, { header: "Due within (days)", key: "due", width: 16 }, { header: "Status", key: "st", width: 12 },
  ];
  for (const a of s.actions) actions.addRow({ p: a.priority, t: a.title, d: a.detail, o: a.owner, due: a.dueInDays, st: "Open" });
  style(actions);

  const findings = wb.addWorksheet("Findings");
  findings.columns = [
    { header: "ID", key: "id", width: 7 }, { header: "Severity", key: "sev", width: 10 }, { header: "Type", key: "type", width: 16 },
    { header: "Finding", key: "title", width: 50 }, { header: "Detail", key: "detail", width: 80 }, { header: "Spend (AUD)", key: "spend", width: 14 },
    { header: "Evidence", key: "ev", width: 18 },
  ];
  for (const f of s.findings) findings.addRow({ id: f.id, sev: f.severity, type: f.type, title: f.title, detail: f.detail, spend: Math.round(f.spendAud), ev: f.evidenceIds.join(", ") });
  style(findings);

  const ev = wb.addWorksheet("Evidence");
  ev.columns = [
    { header: "ID", key: "id", width: 7 }, { header: "Iteration", key: "it", width: 10 }, { header: "Tool", key: "tool", width: 22 },
    { header: "Statement", key: "st", width: 100 }, { header: "Queries", key: "q", width: 14 }, { header: "Source systems", key: "sys", width: 40 },
    { header: "Provisional", key: "prov", width: 12 },
  ];
  for (const e of s.evidence) ev.addRow({ id: e.id, it: e.iteration, tool: e.tool, st: e.statement, q: e.queryIds.join(", "), sys: e.systems.join(", "), prov: e.provisional ? "Yes" : "" });
  style(ev);

  const qs = wb.addWorksheet("Zetaris queries");
  qs.columns = [
    { header: "ID", key: "id", width: 7 }, { header: "Purpose", key: "p", width: 60 }, { header: "Tables", key: "t", width: 50 },
    { header: "Rows", key: "r", width: 8 }, { header: "ms", key: "ms", width: 8 }, { header: "SQL", key: "sql", width: 120 },
  ];
  for (const q of s.queries) qs.addRow({ id: q.id, p: q.purpose, t: q.tables.join(", "), r: q.rowCount, ms: q.ms, sql: q.sql });
  style(qs);
  return wb;
}

// ------------------------------------------------------------------ markdown

export function evidencePack(s: RunSummary): string {
  const out: string[] = [];
  out.push(`# Evidence pack: ${s.questionnaireTitle}`, "");
  out.push(`Company: ${s.company}  `, `Client: ${s.client}  `, `Run: ${s.runId} (${s.startedAt} to ${s.finishedAt})  `,
    `Data layer: ${s.dataMode === "zetaris" ? "Zetaris (federated: PostgreSQL ERP, reference lists in object storage, REST supplier portal)" : "Local DuckDB stand-in (offline mode)"}  `,
    `AI: ${s.aiMode === "nightshift" ? `${providerLabel(config.nightshift.baseUrl)} (${Object.keys(s.llmStats.byModel).join(", ")})` : "Deterministic policies (offline mode)"}  `,
    `Iterations: ${s.iterations}. Queries: ${s.queries.length}. Evidence items: ${s.evidence.length}.`, "");
  out.push("## Coverage", "",
    `- Period: ${s.coverage.periodFrom} to ${s.coverage.periodTo}`,
    `- Suppliers: ${s.coverage.suppliers}, spend ${audFmt(s.coverage.spendAud)}`,
    `- Purchase lines: ${s.coverage.lines}, of which ${s.coverage.linesWithOrigin} have an origin (${audFmt(s.coverage.spendWithOrigin)})`,
    `- Line-level screen: ${s.coverage.lineScreenDone ? "done" : "not run"}; declared inputs screen: ${s.coverage.declaredInputsDone ? "done" : "not run"}`,
    `- Declarations: ${s.coverage.declarations} received, ${s.coverage.declarationsLinked} linked and confirmed`,
    `- Sanctions: scope ${s.coverage.sanctionsScope}, ${s.coverage.namesScreened} names against ${s.coverage.sanctionsListNames} listed names (${s.sources.sanctions})`,
    "");
  if (s.sources.sanctionsNote) out.push(`> Sanctions list: ${s.sources.sanctionsNote}`, "");

  out.push("## Answers", "");
  for (const a of s.answers) {
    out.push(`### ${a.question.id}. ${a.question.text}`, "", `Status: **${STATUS_LABEL[a.status]}** after ${a.iterations} draft${a.iterations === 1 ? "" : "s"}`, "", a.answer, "");
    if (a.history.length > 1) {
      out.push("<details><summary>How this answer changed</summary>", "");
      for (const h of a.history) out.push(`- Iteration ${h.iteration}: ${h.verdict}. ${h.issues.length ? h.issues.map((i) => `[${i.gate}] ${i.detail}`).join(" ") : h.summary}`);
      out.push("", "</details>", "");
    }
  }

  out.push("## Needs a person", "");
  if (!s.escalations.length) out.push("Nothing.", "");
  for (const e of s.escalations) out.push(`- **${e.id} ${e.title}** (${e.type}, ${e.status}). ${e.detail}${e.action?.proposal ? ` Proposed wording: "${e.action.proposal}"` : ""}`);
  out.push("");

  out.push("## Supplier risk", "", "| Supplier | Risk | Score | Spend | Why |", "|---|---|---|---|---|");
  for (const r of s.supplierRisks) out.push(`| ${r.name} | ${r.level} | ${r.score} | ${audFmt(r.spendAud)} | ${r.reasons.join("; ") || "No indicators"} |`);
  out.push("");

  out.push("## Actions", "");
  for (const a of s.actions) out.push(`- P${a.priority} **${a.title}** (${a.owner}, within ${a.dueInDays} days). ${a.detail}`);
  out.push("");

  out.push("## Evidence", "");
  for (const e of s.evidence) {
    out.push(`- **${e.id}** (iteration ${e.iteration}, ${e.tool}${e.provisional ? ", provisional" : ""}): ${e.statement}${e.queryIds.length ? ` Queries: ${e.queryIds.join(", ")}.` : ""}${e.sourceUrls?.length ? ` Sources: ${e.sourceUrls.join(", ")}` : ""}`);
  }
  out.push("");

  out.push("## Queries", "");
  for (const q of s.queries) {
    out.push(`### ${q.id}: ${q.purpose}`, "", `Tables: ${q.tables.join(", ") || "none"}. Systems: ${q.systems.join(" + ")}. Rows: ${q.rowCount}. ${q.ms} ms.${q.ok ? "" : ` FAILED: ${q.error}`}`, "", "```sql", q.sql, "```", "");
  }
  return out.join("\n");
}
