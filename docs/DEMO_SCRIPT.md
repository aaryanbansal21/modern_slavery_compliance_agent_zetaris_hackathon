# Demo video script (about 3 minutes 30 seconds)

The limit is 4 minutes. Record at 1440 x 900 or larger, browser zoom 100%. Run the app in full mode (`DATA_MODE=zetaris`, `AI_MODE=nightshift`) and do one warm-up run first, so the model cache makes the recorded run quick. Before recording, reset the World Model so the human-in-the-loop moment appears: stop the app, delete `.data/world`, start it again.

## 0:00 to 0:25 The problem

Screen: the app's Answers tab before a run, showing the client's 10 questions.

Say: "Big Australian companies already report on modern slavery in their supply chains. In July the government announced plans to make failing to prevent it a criminal offence, with a defence for companies that took reasonable steps. They push that work onto small suppliers with questionnaires like this one. Harbourside is a 46-person cleaning company. It has no compliance team, so it usually answers from memory: our suppliers are Australian, so no risk. That answer is usually wrong."

## 0:25 to 0:45 The data

Screen: Data and AI tab, then the Zetaris SQL Editor showing `SHOW LIGHTNING DATABASES` and the registered tables.

Say: "Reasonable Steps reads Harbourside's real systems through Zetaris: the ERP in PostgreSQL, the supplier portal's REST API, and the public risk lists in object storage: the DFAT sanctions list and the US Department of Labor's forced labour list. Zetaris joins them in single queries, so the agents only see answer rows."

## 0:45 to 1:30 The agents at work

Screen: press "Check suppliers and draft answers". The Agent trace tab streams.

Say: "The planner starts proportionately, with cheap checks for a first draft. Watch the evaluator, running on NVIDIA Nemotron through Meterless Nightshift. It sends four drafts back. Question 3 said we have no high-risk goods, but no purchase line had been checked. The planner reacts: it resolves supplier identities, screens all 39 purchase lines by product and country of origin, checks inputs named in supplier declarations, and widens the sanctions screen to manufacturers and parent companies."

Point at: a red "REVISE" verdict, then a federated query row (click Show SQL once).

## 1:30 to 2:15 Why the answer changed

Screen: Answers tab, question 3. Scroll to "How this answer changed".

Say: "Here is the first draft, struck through, with the evaluator's reasons in the margin. And here is the answer now: nitrile gloves made in Malaysia, cotton mop heads from China, solar panels from China, each with the supplier and the spend. Every claim has an evidence chip."

Click an evidence chip. Say: "Each piece of evidence shows the exact SQL Zetaris ran and the rows it returned. A client can audit any sentence."

Then show the NordicClean line in the answer: "This one is subtle. The invoice says the floor scrubber was made in Germany. The supplier's own declaration says the battery cells come from China. The agent caught it by joining the portal with the forced labour list."

## 2:15 to 2:50 What only a person decides

Screen: Needs you tab.

Say: "Two things stop for a person. The answer to question 10 commits the business to notifying the client, so the owner approves the wording. And a portal record from 'Cleanpro Supply Co' has no ABN. The Meterless World Model scored it 0.82 against our supplier CleanPro Supplies, inside the review band, so it asks instead of guessing." Click "Yes, same company" and "Approve this wording".

Screen: World Model tab, merge queue and audit log, then Suppliers tab with CleanPro expanded: "Iteration 1: Low, then Iteration 2: High".

Say: "The World Model is the shared memory for every agent. It keeps how the assessment changed, and it remembers this decision next time."

## 2:50 to 3:20 The result

Screen: press "Run the checks again". Show 10 of 10 ready. Download the Word file and open it briefly.

Say: "Run again, and all ten answers are ready, with a risk register, an action plan and an evidence pack. What took a small business days of guessing takes minutes, and the answers stand up."

## 3:20 to 3:30 Close

Screen: README architecture diagram or the title slide.

Say: "Reasonable Steps. Zetaris for the data, the Meterless World Model for shared state, Nightshift and Nemotron for the reasoning. Built so small suppliers can show their reasonable steps."
