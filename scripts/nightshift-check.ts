// Check the Meterless Nightshift connection and every agent's model route.
//   npm run nightshift:check
//   npm run nightshift:check -- --detect      also run Auto Detect on the usual ports
import { config } from "../src/config.ts";
import { extractJson } from "../src/llm/json.ts";
import { autoDetect, NightshiftClient, resolveToken } from "../src/llm/nightshift.ts";

const { token, from } = resolveToken(config.nightshift.token, config.nightshift.tokenFile);
console.log(`Token: ${token ? `found (${from})` : "not found. Set METERLESS_RUNTIME_TOKEN, or METERLESS_TOKEN_FILE to <stateDir>/proxy-token"}`);

if (process.argv.includes("--detect")) {
  const hit = await autoDetect(config.nightshift.appId, token);
  console.log(hit ? `Auto Detect: ${hit.state} at ${hit.baseUrl}` : "Auto Detect: no runtime on ports 8088, 8090, 8787, 11434");
}

const client = new NightshiftClient(config.nightshift.baseUrl, token, config.nightshift.appId, config.nightshift.timeoutMs);
const status = await client.status();
console.log(`Runtime at ${client.baseUrl}: ${status.state}. ${status.detail}`);
if (status.state !== "online") process.exit(1);

console.log("\nRoutes offered by Nightshift:");
for (const m of status.models) console.log(`  ${m}${/nemotron|nvidia/i.test(m) ? "   <- NVIDIA" : ""}`);
const nvidia = status.models.filter((m) => /nemotron|nvidia/i.test(m));
if (!nvidia.length) {
  console.log("\nNo NVIDIA route is listed. Add your NVIDIA API key in Nightshift's Providers tab, then rerun.");
  console.log("If Nightshift routes NVIDIA models through a class or disposition id, set MODEL_EVALUATOR to that id.");
}

console.log("\nTesting each agent role (one short JSON request each):");
const roles = Object.entries(config.nightshift.models);
for (const [role, model] of roles) {
  try {
    const r = await client.chat(model, [
      { role: "system", content: "Reply with JSON only." },
      { role: "user", content: `Return {"ok": true, "role": "${role}"}` },
    ], { temperature: 0, maxTokens: 60 });
    const parsed = extractJson(r.text) as { ok?: boolean };
    console.log(`  ${role.padEnd(11)} ${model.padEnd(28)} answered by ${r.model} in ${(r.latencyMs / 1000).toFixed(1)} s ${parsed?.ok ? "JSON ok" : "JSON not parsed"}`);
  } catch (err) {
    console.log(`  ${role.padEnd(11)} ${model.padEnd(28)} FAILED: ${(err as Error).message.slice(0, 200)}`);
  }
}
console.log("\nThe evaluator should run on a Nemotron route. Set MODEL_EVALUATOR in .env to the id above.");
