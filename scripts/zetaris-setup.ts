// Register the ERP (PostgreSQL), the reference lists (MinIO/S3) and the
// supplier portal (REST) in Zetaris, one statement at a time.
//   npm run zetaris:setup -- --dry-run     print the statements only
//   npm run zetaris:setup                  run them
//   npm run zetaris:setup -- --only=portal-view
//   npm run zetaris:setup -- --teardown    print the drop statements
import { config } from "../src/config.ts";
import { setupStatements, teardownStatements } from "../src/data/zetarisSetup.ts";
import { ZetarisSource } from "../src/data/zetaris.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];

if (args.includes("--teardown")) {
  console.log("Run these in the Zetaris SQL Editor, one at a time, to remove the objects:\n");
  for (const s of teardownStatements()) console.log(`${s};`);
  console.log("\nSchemaStore containers have no SQL drop command; remove rs_views in Data Explorer if needed.");
  process.exit(0);
}

const statements = setupStatements().filter((s) => !only || s.step === only);
if (dryRun) {
  for (const s of statements) console.log(`-- ${s.step}\n${s.display};\n`);
  process.exit(0);
}

const zetaris = new ZetarisSource(config.zetaris);
const status = await zetaris.status();
console.log(status.detail);
if (!status.ok) {
  console.error("\nCannot reach Zetaris. Check ZETARIS_BASE_URL, ZETARIS_ORG_ID and your credentials in .env.");
  process.exit(1);
}

let failed = 0;
for (const s of statements) {
  process.stdout.write(`${s.step.padEnd(22)} `);
  try {
    await zetaris.query(s.sql);
    console.log("ok");
  } catch (err) {
    const msg = (err as Error).message;
    if (/already exist/i.test(msg)) {
      console.log("already exists, skipped");
      continue;
    }
    failed++;
    console.log("FAILED");
    console.log(`  ${msg.slice(0, 500)}`);
    console.log(`  Statement:\n${s.display.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
}
console.log(failed ? `\n${failed} statements failed. Fix them (see docs/SETUP.md, Troubleshooting), then rerun.` : "\nAll sources registered. Next: npm run zetaris:verify");
process.exit(failed ? 1 : 0);
