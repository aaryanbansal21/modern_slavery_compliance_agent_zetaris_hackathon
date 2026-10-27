# Sponsor technology explanation

Written for the submission form. Each section answers one of the form's questions.

## How Zetaris was integrated

Zetaris is the only way the agents reach data. The demo company's information lives in three separate systems, as it would for a real small business:

- an ERP in PostgreSQL (supplier master, 12 months of invoice lines, company registers)
- a supplier declaration portal, a JSON REST API where suppliers type their own details with no internal IDs
- public reference lists as CSV files in S3-compatible storage: the Australian Sanctions Consolidated List (DFAT), the US Department of Labor List of Goods Produced by Child Labor or Forced Labor, a product taxonomy and a high-risk sector list

`npm run zetaris:setup` registers them with Lightning SQL: `CREATE DATASOURCE` and `REGISTER DATASOURCE TABLES` for the ERP over JDBC, `CREATE LIGHTNING FILESTORE TABLE ... FORMAT CSV` over `s3a://` paths for the reference lists, and `CREATE LIGHTNING REST TABLE` plus a `CREATE SCHEMASTORE VIEW ... LATERAL VIEW explode(data)` for the portal. The app sends SQL to Zetaris through its query API (`/api/proxy/sql-editor/sqls/run-query`).

The agents use a library of federated query templates, and the planner chooses which to run. Examples:

- The line screen joins ERP purchase lines and suppliers with the product taxonomy and the DOL list, matching on good and country of origin, in one statement across two systems.
- The declared-inputs screen joins the REST portal view with the taxonomy and the DOL list, to find components (battery cells, polysilicon) that invoices do not show.
- The sanctions screen fuzzy-matches every resolved company name against thousands of DFAT names and aliases with `levenshtein()` inside Zetaris, returning only the nearest matches and anything above the threshold.

Joins and filtering happen in Zetaris, so the models only see the answer rows. Every query is recorded with an ID, its SQL, the tables and systems it touched, its row count and its timing. Answers cite evidence, and evidence cites those query IDs, so any claim can be traced back to the SQL Zetaris ran. `npm run zetaris:verify` checks every table and every template through Zetaris against an offline copy.

## Meterless Engines implemented

**World Model** (`src/engines/world-model/`), implemented from the Meterless specification (`engines/world-model/AGENTS.md`).

What it does in this product: it is the shared state between the agents and between runs. The resolver writes suppliers, manufacturers, purchase lines, countries, goods and declarations into it. The executor writes evidence with provenance pointing at Zetaris query IDs. The risk scorer writes each supplier's risk level as a fact every iteration, so the history shows how the assessment changed (for example CleanPro Supplies: Low after supplier-level checks, High after the line screen). The drafter's answers are facts on question entities.

Features used:

- stable content-addressed IDs (`type:system:externalId` for ERP records, hashed normalized names otherwise)
- the merge bands from the spec: similarity of 0.85 or more auto-merges, 0.82 to 0.85 goes to a human review queue, lower creates a new entity. The supplier portal has no internal IDs, so this is how portal records link to ERP suppliers. "Cleanpro Supply Co" scores 0.82 against "CleanPro Supplies Pty Ltd" and waits for a person. "Yiwu Bright Textiles Co Ltd" merges with "Yiwu Bright Textile Co., Ltd" at 0.95.
- provenance required on every write ("no provenance, no write")
- bitemporal relationships with point-in-time queries
- facts with a conflict policy, superseded rather than overwritten
- an append-only event log, an ordered audit log, rebuildable views and replay verification
- persistence between runs: a merge a person approves in the app is an alias event, so the next run links the record automatically

The control plane is the World Model tab in the app: entity browser with facts and relationship history, the merge review queue with approve and reject, the audit log, and "Rebuild views from the log", which replays the event log and confirms the state matches.

The test showing it works: `npm run conformance` runs the official Meterless World Model conformance suite (copied unchanged from the Meterless repo, apart from the path to this implementation). Result: 8 of 8 checks pass (stable IDs, merge band boundaries, provenance enforcement, ingest idempotency in both directions, bitemporal supersession, audit ordering). `test/world-model.test.ts` adds tests for the review queue, superseded facts, replay and no-op writes, and `test/e2e.test.ts` shows decisions persisting across two runs.

## Where NVIDIA technology contributes

NVIDIA Nemotron answers every model call in the demo, through NVIDIA's OpenAI-compatible API. Each agent role has its own model setting:

- Nemotron 3 Ultra runs the planner, the evaluator and the sanctions adjudicator. The evaluator reviews every drafted answer after the deterministic gates, and the adjudicator reviews sanctions name alerts against identifiers such as entity type and country.
- Nemotron 3.5 Bolt, a small fast model, parses the questionnaire, classifies purchase lines the product taxonomy misses and reviews identity links between the supplier portal and the ERP.

The drafter writes from tested templates, so every sentence traces to evidence and no answer is graded by the model that wrote it. Nemotron's review sits above the gates. It can add issues, escalate to a person or request more checks, which sends the planner back for evidence, but it can never clear a gate. When it asks for a rewrite that needs no new evidence, its points are kept as notes on the answer for the owner to read.

Every call is logged in the trace with the role, the model requested, the model that answered and the latency. Model output is validated against a schema. Invalid output gets one repair attempt, then the role's deterministic policy takes over with a warning in the trace, so a model failure never breaks a run. Nemotron 3 models reason before answering by default, and that reasoning used up the whole token budget, so the client turns thinking off and asks for the JSON answer directly.

## How the model client relates to Meterless

`src/llm/nightshift.ts` was written to the Meterless Runtime provider contract 0.90.0. It normalizes any pasted URL to `<host>/v1`, sends a bearer token, sends `meterless-app: slavery-compliance-agent` on every request and `meterless-scope: user` on chat, decides status from `GET /v1/models` (401 or 403 is unauthorized, not offline) and supports Auto Detect on ports 8088, 8090, 8787 and 11434. The demo points it at NVIDIA's API, because the free Mac edition of Nightshift runs only small models on the Mac's own GPU. Our Meterless integration is the World Model engine described above.

## What was unique about our use of the sponsor technologies

- Zetaris carries the evidence chain, not just the data. Each answer cites evidence, each evidence item cites the Zetaris queries that produced it, and the evidence pack prints the SQL. A client's procurement team can audit any claim.
- The World Model's merge bands solve a real fragmented-data problem: supplier portals do not carry your internal IDs. The review band becomes a human-in-the-loop step in the product, and the person's decision persists as an alias event.
- The risk level history in the World Model shows the agent changing its mind with evidence, which is exactly what "explain why" asks for.
- The evaluator's gates are a floor that the model cannot lower, and Nemotron is the judge above them, reviewing drafts it did not write.
