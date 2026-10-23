# Submission checklist

| Requirement | Where it is |
|---|---|
| Demo video, 1 to 4 minutes | Record from docs/DEMO_SCRIPT.md |
| Slide deck | Outline below |
| Public GitHub repository with README | This repository; README.md covers setup, usage and dependencies |
| Sponsor technology explanation | docs/SPONSOR_TECH.md |
| Meterless Engine test | `npm run conformance` (official suite, 8 of 8) and test/world-model.test.ts |
| Zetaris as the data layer | src/data/zetaris.ts, src/data/zetarisSetup.ts, `npm run zetaris:verify` |
| Nightshift as the primary AI provider | src/llm/nightshift.ts, src/llm/router.ts, `npm run nightshift:check` |
| NVIDIA | Nemotron route for the evaluator and adjudicator (`MODEL_EVALUATOR`) |
| No committed secrets | `.env` is gitignored; `.env.example` has placeholders only |

## Track

Track 2: The Agent That Can Explain Why. The agents investigate across the ERP, the supplier portal and the public risk lists, connect findings (identity resolution, upstream inputs), and produce answers where every claim cites evidence and every evidence item cites the query that produced it.

## Pre-existing components declaration

Paste into the form:

> No pre-existing product code. All application code was written during the build window. Two items come from the Meterless open-source repository (Apache 2.0): the World Model conformance runner, copied unchanged apart from the path to our implementation (test/conformance/world-model-runner.ts), and the World Model specification that our engine implements (src/engines/world-model/). Third-party libraries are listed in package.json. Reference data sources are listed in NOTICE.

## Slide deck outline

1. **Reasonable Steps.** One line: evidence-backed answers to modern slavery questionnaires, for small suppliers.
2. **The problem.** Large companies already report on modern slavery risk. In July 2026 the government announced plans for a criminal offence for failing to prevent it, with a "reasonable steps" defence (still in consultation, so say "proposed"). They push the work onto small suppliers through questionnaires. Small suppliers answer from memory. Include your real user quote here.
3. **Who it is for.** Small suppliers to large Australian companies: cleaning, facilities, trades, uniforms, catering. The demo company: Harbourside Facility Services, 46 staff, 13 suppliers, answering Meridian Property Group.
4. **What it does.** Screenshot of the Answers tab with an evidence chip open.
5. **How the agents work.** The flowchart from the README: planner, executor over Zetaris, risk scorer, drafter, evaluator, with the revise and escalate loops.
6. **Explain why.** Screenshot of "How this answer changed" for question 3: the struck-through first draft, the evaluator's reasons, the final answer.
7. **Fragmented data, joined.** The three systems, the Zetaris objects, and one federated query. Call out the NordicClean catch: invoice says Germany, declaration says China battery cells.
8. **Sponsor technology.** Zetaris (federation and the evidence chain), Meterless World Model (shared state, merge bands, fact history, conformance 8 of 8), Nightshift (provider contract, per-role routes), NVIDIA Nemotron (independent evaluator and adjudicator).
9. **People stay in charge.** Needs you tab: owner sign-off, identity review. World Model remembers the decision.
10. **Results on the demo data.** 10 questions, 39 purchase lines, 3 systems, 2 iterations, 4 drafts sent back, 4 high-risk and 3 medium-risk suppliers, 2 decisions for a person, 10 of 10 ready after review.
11. **What is next.** Accounting connectors (Xero, MYOB) in place of the demo ERP; more reference lists (OpenSanctions, Anti-Slavery Commissioner declarations when published); supplier-facing follow-up requests; quarterly re-checks that report what changed.
