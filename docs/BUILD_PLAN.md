# Plan to submission

Submissions close **Wednesday 28 October, 10:45 am Sydney time** (27 October 23:45 UTC). Aim to submit on Tuesday night and keep Wednesday morning as a buffer.

## Where things stand

Done and tested offline (24 tests pass):

- the agent system: parser, planner, executor tools, resolver, classifier, adjudicator, risk scorer, drafter, evaluator, orchestrator
- the Meterless World Model engine, passing the official conformance suite 8 of 8
- the Zetaris client, the federated query library, and scripts that register and verify all three source systems
- the Meterless Nightshift client, model router and route check
- the web app (answers, suppliers, needs you, agent trace, World Model control plane, data and AI)
- Word, Excel and Markdown outputs, demo data, docs, demo script and sponsor tech text

Left for you, because it needs your accounts and your machine:

1. HackOS registration, team and track
2. Zetaris installed and the sources registered
3. Nightshift with NVIDIA connected
4. One full run in Zetaris and Nightshift mode
5. A public GitHub repository
6. One real user quote
7. The video, the deck and the form

## Friday 23 October

**Afternoon**

- [ ] Log in to HackOS. Registration closed at 10:45 am today. If you are not registered, email hackathons@genai.works now.
- [ ] Create your team on HackOS (a solo team is fine) and choose Track 2, The Agent That Can Explain Why.
- [ ] Start the Zetaris download: Zetaris Cloud, Run locally, `zetaris-platform.zip`. It takes 30 to 45 minutes. In Docker Desktop, give Docker at least 8 GB of memory. If your Mac has only 8 GB in total, use the managed AWS cluster instead (docs/SETUP.md, Zetaris on AWS).
- [ ] While it downloads, watch the DATA workshop recording (Zetaris) in the HackOS Resource Center.
- [ ] Run the project offline:

```bash
cd ~/Code/slavery_compliance_agent
npm install
cp .env.example .env
npm test
npm start          # open http://localhost:4180 and run the checks
```

**Evening**

- [ ] Finish the Zetaris install and confirm `SELECT 1 AS one;` in the SQL Editor (docs/SETUP.md, step 2).
- [ ] Start the sources and load them:

```bash
docker compose up -d
npm run fetch:data
npm run seed:postgres
npm run upload:minio
```

- [ ] In the Zetaris UI, copy the organisation ID (Management, Organisation) and create an API token (Management, API Tokens). Put both in `.env`.
- [ ] Register and verify:

```bash
npm run zetaris:setup
npm run zetaris:verify
```

If a statement fails, the script prints the error and the SQL. Try the fixes in docs/SETUP.md, Troubleshooting, then ask in the Help Zetaris channel with that output.

- [ ] Create the GitHub repository and push. Commits made now are inside the build window:

```bash
git init
git add .
git commit -m "Reasonable Steps: modern slavery due diligence agent"
gh repo create slavery_compliance_agent --public --source . --push
```

## Saturday 24 October

**Afternoon**

- [ ] Watch the POWER workshop recording (Nightshift with NVIDIA models).
- [ ] Install Meterless Nightshift. Get an NVIDIA API key at build.nvidia.com and add it in Nightshift's Providers tab.
- [ ] Put the runtime token (from `<stateDir>/proxy-token`) in `.env`, then:

```bash
npm run nightshift:check -- --detect
```

- [ ] Set `MODEL_EVALUATOR` to the Nemotron route the check lists. If the drafter falls back often, try a stronger route for `MODEL_DRAFTER`.

**Evening**

- [ ] Set `DATA_MODE=zetaris` and `AI_MODE=nightshift`, then `npm run reset` and `npm start`. Run the checks.
- [ ] Read every answer and the trace. Look for warning rows (a model's output was unusable and the policy took over) and failed queries.
- [ ] Approve the two items under Needs you, run again, and confirm 10 of 10 answers are ready.
- [ ] Take screenshots of each tab in full mode, for the deck.
- [ ] Commit and push.

## Sunday 25 October

- [ ] Get one real quote. Call two or three small business owners who supply larger companies (cleaning, facilities, construction trades, uniforms, catering). Ask: "Has a big client sent you a modern slavery or supplier questionnaire? How long did it take, and how did you answer it?" With permission, note one sentence and their role. This is the strongest thing you can add to Impact (30 points).
- [ ] Build the slide deck (docs/SUBMISSION.md has the outline). Ask Claude to build it from the screenshots if you want.
- [ ] Rehearse docs/DEMO_SCRIPT.md out loud twice and time it.

## Monday 26 October

- [ ] Record the video. Use `npm run reset`, do one warm-up run so the model cache is warm, reset again, then record. QuickTime (File, New Screen Recording) with your microphone works. Keep it under 4 minutes.
- [ ] Upload it as an unlisted YouTube video, or to Loom or Google Drive with link sharing on. Check the link in a private browser window.
- [ ] Finish the deck and export it as PDF.

## Tuesday 27 October

- [ ] Fresh clone test: clone the GitHub repo to a new folder, then `npm install`, `npm test`, `npm start`.
- [ ] Secrets check: `git grep -nE "eyJ|nvapi-|AKIA|password=" -- . ':!.env.example'` returns nothing, and `.env` is not in the repo.
- [ ] Fill in the HackOS submission:
  - Track 2, The Agent That Can Explain Why
  - demo video link
  - slide deck
  - GitHub repository URL (public)
  - sponsor technology explanation: paste docs/SPONSOR_TECH.md
  - pre-existing components: paste the declaration from docs/SUBMISSION.md
- [ ] Submit before you sleep. The deadline is 10:45 am Wednesday.

## If something breaks

| Problem | What to do |
|---|---|
| Zetaris will not install or start | Run `./preflight.sh` and fix what it reports. If memory is the issue, use the managed AWS cluster and the AWS route in docs/SETUP.md. |
| A setup statement fails | Read the printed error. Try the host network fix in docs/SETUP.md. Ask in Help Zetaris with the script output. |
| Nightshift shows no NVIDIA route | Check the Providers tab and the POWER recording. Ask in Help Meterless. Until then the evaluator can run on `meterless/deep`. |
| A model returns unusable output | The agent falls back to its deterministic policy and the trace shows a warning. Try another route for that role. |
| Time is running out | Submit with what works. A full run in Zetaris mode, the video and the repo matter most. The offline mode is for development only, since Zetaris is a requirement. |
