// Write the demo client questionnaire as a Word document, so the demo can
// show a real upload. Numbers are written into the text, because Word's
// automatic numbering is lost when a .docx is read as plain text.
//   npm run make:questionnaire
import fs from "node:fs";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { DEMO_DIR } from "../src/data/prepare.ts";

const md = fs.readFileSync(path.join(DEMO_DIR, "questionnaire.md"), "utf8").split(/\r?\n/);
const children: Paragraph[] = [];
for (const line of md) {
  if (!line.trim()) continue;
  if (line.startsWith("# ")) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(line.slice(2))] }));
  else children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: line, size: 22, font: "Calibri" })] }));
}
const doc = new Document({ creator: "Meridian Property Group (demo)", title: "Supplier Modern Slavery Questionnaire 2026", sections: [{ children }] });
const out = path.join(DEMO_DIR, "questionnaire.docx");
fs.writeFileSync(out, await Packer.toBuffer(doc));
console.log(`Wrote ${out}`);
