// Parser agent: turns the client's questionnaire (Markdown, text or Word)
// into structured questions, each tagged with the topic that decides which
// evidence it needs.
import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { z } from "zod";
import type { LlmRouter } from "../llm/router.ts";
import { PARSER_SYSTEM } from "./prompts.ts";
import { TOPICS, type Question, type Topic } from "./types.ts";

export interface ParsedQuestionnaire {
  title: string;
  client: string;
  questions: Question[];
  text: string;
}

export async function readQuestionnaireText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path: file });
    return value;
  }
  return fs.readFileSync(file, "utf8");
}

const TOPIC_RULES: [Topic, RegExp][] = [
  ["notification", /\bnotify|notification\b/i],
  ["sanctions", /sanction/i],
  ["grievance", /grievance|whistle ?blow/i],
  ["training", /\btrain(ing|ed)?\b/i],
  ["labour_and_subcontractors", /labour hire|labor hire|subcontract|contractors?\b/i],
  ["high_risk_goods", /high[- ]risk|known to carry/i],
  ["countries", /\bcountr(y|ies)\b/i],
  ["risks_and_actions", /identified any|incidents?|actions? (have you|taken)/i],
  ["due_diligence", /due diligence|questionnaires?|audits?|certification/i],
  ["policy", /\bpolicy|policies|code of conduct/i],
];

export function topicFor(text: string): Topic {
  for (const [topic, re] of TOPIC_RULES) if (re.test(text)) return topic;
  return "other";
}

export function parseQuestionsPolicy(text: string): Omit<ParsedQuestionnaire, "text"> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const title = (lines.find((l) => l.length > 0) ?? "Supplier questionnaire").replace(/^#+\s*/, "");
  const requested = text.match(/Requested by:\s*([^\n,(]+)/i)?.[1]?.trim();
  const client = requested ?? title.split(":")[0].trim();

  const numbered: { number: number; text: string }[] = [];
  let current: { number: number; text: string } | undefined;
  for (const line of lines) {
    const m = line.match(/^(?:Q\s*)?(\d{1,2})[.)]\s+(.+)$/i);
    if (m) {
      current = { number: Number(m[1]), text: m[2] };
      numbered.push(current);
    } else if (current && line && !/^#/.test(line) && !/:$/.test(line) && numbered.length && line.length < 400) {
      // continuation of a wrapped question
      if (!/^[A-Z][a-z]+:\s/.test(line)) current.text += ` ${line}`;
    } else if (!line) {
      current = undefined;
    }
  }
  let items = numbered;
  if (!items.length) {
    items = lines.filter((l) => l.endsWith("?") && l.length > 15).map((l, i) => ({ number: i + 1, text: l }));
  }
  const questions = items.map((q) => ({ id: `Q${q.number}`, number: q.number, text: q.text.trim(), topic: topicFor(q.text) }));
  return { title, client, questions };
}

const ParserOut = z.object({
  title: z.string().min(1),
  client: z.string().min(1),
  questions: z.array(z.object({ number: z.number().int(), text: z.string().min(5), topic: z.string() })).min(1),
});

export async function parseQuestionnaire(text: string, llm: LlmRouter): Promise<ParsedQuestionnaire> {
  const policy = () => {
    const p = parseQuestionsPolicy(text);
    return { title: p.title, client: p.client, questions: p.questions.map((q) => ({ number: q.number, text: q.text, topic: q.topic })) };
  };
  const { value } = await llm.json(
    "parser",
    "Parse questionnaire into structured questions",
    [
      { role: "system", content: PARSER_SYSTEM },
      { role: "user", content: text.slice(0, 12_000) },
    ],
    ParserOut,
    policy,
    { temperature: 0 },
  );
  const questions = value.questions.map((q) => {
    const topic = (TOPICS as string[]).includes(q.topic) ? (q.topic as Topic) : topicFor(q.text);
    return { id: `Q${q.number}`, number: q.number, text: q.text.trim(), topic };
  });
  return { title: value.title, client: value.client, questions, text };
}
