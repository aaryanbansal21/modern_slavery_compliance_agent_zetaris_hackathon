// Run one assessment from the command line and print what happened.
//   npm run demo                 uses DATA_MODE and AI_MODE from .env
//   npm run demo -- --offline    forces the deterministic policies (no model calls)
import { runAssessment } from "../src/agents/orchestrator.ts";
import { writeOutputs } from "../src/reporting/outputs.ts";

const offline = process.argv.includes("--offline");
const quiet = process.argv.includes("--quiet");
const fileArg = process.argv.find((a) => a.startsWith("--questionnaire="))?.split("=")[1];

const summary = await runAssessment({
  questionnaireFile: fileArg,
  offlineAi: offline ? true : undefined,
  onTrace: quiet ? undefined : (e) => {
    const tag = `${String(e.iteration).padStart(1)} ${e.agent.padEnd(12)} ${e.type.padEnd(10)}`;
    console.log(`${tag} ${e.title}${e.detail && ["verdict", "plan", "escalation", "error", "warning"].includes(e.type) ? `\n${" ".repeat(26)}${e.detail.slice(0, 300)}` : ""}`);
  },
});
const files = await writeOutputs(summary);

console.log("\n=== Answers");
for (const a of summary.answers) console.log(`${a.question.id} [${a.status}] (${a.iterations} drafts) ${a.answer.slice(0, 160).replace(/\n/g, " ")}...`);
console.log("\n=== Supplier risk");
for (const r of summary.supplierRisks) console.log(`${r.level.padEnd(12)} ${r.score.toFixed(2)}  ${r.name}: ${r.reasons.join("; ")}`);
console.log("\n=== Needs a person");
for (const e of summary.escalations) console.log(`${e.id} ${e.type}: ${e.title}`);
console.log(`\n${summary.iterations} iterations, ${summary.queries.length} Zetaris queries, ${summary.evidence.length} evidence items, ${summary.llmStats.calls} model calls.`);
console.log("Outputs:");
for (const f of files) console.log(`  ${f}`);
