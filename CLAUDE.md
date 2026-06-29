# SentimentPulse — Project Context for Claude Code

## What This Project Is
A full-stack game publisher sentiment tracking application. It scrapes Steam Reviews, Steam Forums, and Reddit daily, classifies community posts by sentiment (positive/negative/neutral), extracts recurring topics, and presents findings on a React dashboard with KPI visualizations, executive summaries, and AI-generated recommended actions.

## Tech Stack
- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS + shadcn/ui + Recharts + TanStack Query
- **Backend**: Python FastAPI + Uvicorn + SQLAlchemy
- **Database**: SQLite (dev) / PostgreSQL (prod) via DATABASE_URL env var
- **NLP**: HuggingFace Transformers (cardiffnlp/twitter-roberta-base-sentiment-latest) + VADER fallback
- **Topic Modeling**: BERTopic / LDA (scikit-learn)
- **Scheduler**: APScheduler (daily 2:00 AM ingestion)
- **Reddit**: PRAW library
- **AI Summaries**: Anthropic Claude API (claude-3-5-haiku-latest)

## Key Architecture Decisions
- All external IDs (Steam review IDs, Reddit post IDs) are stored with a composite unique constraint (external_id + source) to prevent duplicate ingestion
- The ingestion pipeline is in `backend/ingestor.py` — it is the single source of truth for data collection
- All API keys live in `.env` — never hard-code credentials
- The default selected game in the UI is always the most recently released game by the publisher

## Database Tables
publishers → games → raw_posts → sentiment_records
games → daily_summaries (one per game per day)
games → topic_trends (rolling topic lifetime records)

## Frontend Routes
/ → Dashboard (KPI overview, default: most recent game)
/summary → Executive Summary + Recommended Actions
/topics → Topic Trends browser
/posts → Raw Posts browser
/settings → Publisher config + game management

## Current Build Phase
Phase 12 complete — all phases done

## API Base URL
Frontend calls backend at http://localhost:8000/api in dev (Vite proxy configured)

## DO NOT
- Do not add features beyond what is specified unless asked
- Do not change the database schema without running a new Alembic migration
- Do not remove existing tests
- Do not hard-code publisher names or game IDs — all must come from the database

<!-- BEGIN PRINCIPLES PROMPT COPY -->

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### 7. QA Before Commit/Deploy (always-on, all projects)
- **Run every applicable QA gate before asking the user to commit, push, deploy, merge, or otherwise make a change permanent.** This rule supersedes any contrary instruction in a single session.
- "QA gate" means whatever is appropriate for the file types changed: `npm run build`, `tsc --noEmit`, `nginx -t`, `python -m py_compile`, `pytest`, ESLint, JSX parse, schema migrations dry-run, smoke tests against staging, or — at minimum — a manual diff review confirming intent.
- Confirm SEO/copy/content edits match the **actual current behavior** of the page or feature, not a stale spec or placeholder. Read the live page (or the rendered component) when the copy describes user-visible behavior.
- Check for stray conflict markers (`<<<<<<<`, `>>>>>>>`, `=======`) outside of `node_modules`/`dist`.
- Verify imports/exports/types remain consistent (e.g. dropped `useEffect` import when refactoring to `<SEOHead>`).
- If a QA check cannot be run in the current environment (no nginx binary, no docker, no test DB, etc.), **explicitly state which check was skipped and why**. Do not silently treat "couldn't run" as "passed."
- Never say "ready to commit", "looks good, push it", or generate a commit/deploy command until every applicable gate has either passed or been explicitly skipped with a reason.


### 8. No Placeholder Commands — QA'd Commands Only (always-on, all projects)
- **Never give the user commands that contain placeholders requiring manual substitution.** Examples of forbidden placeholders: `/path/to/project`, `<your-domain>`, `your-server`, `<container-name>`, `<branch>`, `your-key.pem`, `REPLACE_ME`, `...`, etc.
- Before issuing any shell, deploy, or operational command, **look up the actual values first** — from this CLAUDE.md, the repo (compose files, workflows, scripts, READMEs), memory, prior session context, connected services, or live inspection of the server. If a value isn't available, find it before producing the command.
- Every command you give must be **paste-and-run executable verbatim** on the user's machine or server, with no fill-in-the-blanks step.
- If a required value genuinely cannot be obtained, **stop and ask one targeted question for that specific value** — do not paper over it with a placeholder.
- This rule applies on top of (not instead of) the §7 QA-Before-Commit/Deploy gate: commands must be both correct and QA'd before being handed to the user.
- **No copy-paste-between-steps.** Never give the user a command whose output they must paste back into a follow-up command. If a value (key, token, SHA, URL) must flow between steps, capture it programmatically: assign it to a shell variable in the same command, write it to a file the next command reads, or call an API directly. The user should never be a manual data pipe.
- Self-check before every command block: "Could this run unattended in a script?" If no, fix it before sending.

### 9. QA Every PR Before Marking Done (REQUIRED)
- **Every code change that touches behavior MUST be QAed end-to-end before the PR/task is marked complete.**
- For backend changes: run the relevant tests AND hit the actual endpoint(s) with curl against the live droplet or local server. Don't trust that "it compiles" or "tests pass" means the user-facing flow works.
- For frontend changes: build the frontend, screenshot the affected page(s) at desktop width, visually inspect the result.
- For changes that touch both: do both.
- If the QA reveals a problem, fix it BEFORE telling the user the work is done. Never report success on something that's broken.
- After the user deploys, run a full live-site QA pass and paste back a results table (what was tested, pass/fail) before declaring the deploy successful.

### 10. Confirm Steps Before Executing Anything Irreversible or Cross-Cutting
- **Always confirm the plan before executing** when the change is:
  - Irreversible (DB migrations, deletes, schema changes, file purges)
  - Cross-cutting (touches multiple apps in the suite, or changes shared Nginx/systemd config)
  - Above ~5 minutes of work (build a brief plan, get sign-off, then execute)
- The confirmation should include: what files change, what services restart, what the user needs to run on the droplet, and what could break.
- Skip confirmation only for: small visual tweaks, copy edits, single-line fixes, and other clearly trivial changes.
- After confirmation, EXECUTE the plan as confirmed — don't add scope mid-execution without asking again.

### 11. Squash Merge Workflow (REQUIRED for non-trivial changes)
Matches the howmanyareplaying.com project process.

- **Work happens on feature branches**, not directly on `main`. Branch naming: `feat/<short-description>`, `fix/<short-description>`, or `chore/<short-description>`.
- **Open a PR** for any change that involves a meaningful behavior change, schema change, multiple files, or anything cross-cutting. Trivial copy edits or one-line bug fixes can go directly to main without a PR.
- **QA the branch BEFORE opening the PR.** Tests pass, endpoints respond correctly, frontend builds cleanly, screenshots inspected. (See Principles 7 and 9.)
- **Computer executes the squash-and-merge for the user**, but ALWAYS confirms first. The confirmation should include: branch name, PR title, summary of changes, and confirmation that QA passed.
- **Squash merge format**: PR title becomes the squashed commit message. Title pattern: `<type>: <imperative summary>` (e.g., `feat: 30-day rolling summaries with bold ideas`, `fix: admin login body parsing under slowapi`).
- After merge, delete the feature branch.
- Auto-deploy on push to main is the goal (see Principle 16 below).

### 13. No Inventing, No Speculating — Evidence-Only Insights (always-on, all projects, all LLM calls)
**Hard, firm requirement for every Claude/LLM call in any pipeline that produces summaries, topic labels, recommendations, or any user-facing insight.**

- **Only draw insights from firm, interpretable content.** Every claim in a summary, recommended action, topic label, or bold idea must trace back to specific words or unambiguous meaning in the source posts/comments. If you cannot point to the exact phrase that supports a claim, do not make the claim.
- **Never guess what a person's comment means.** If a comment is ambiguous, sarcastic, off-topic, too short, or its sentiment is unclear, **tag it neutral and exclude it from the content fed into summary/recommendation generation**. Ambiguous data is worse than no data — it produces confident hallucinations.
- **Never introduce concepts not present in the source.** Do not invent gaming-industry framing (e.g. "free-to-play model", "battle pass", "monetization model", "gacha", "live service", "season pass", "microtransactions") unless those exact terms appear in the underlying posts or topic clusters. The same rule applies to any domain: never add a concept the source didn't contain just because it sounds plausible for the category.
- **Never extrapolate beyond evidence.** If topic labels show "Combat" and "Story", do not conclude anything about pricing, monetization, business model, platforms, marketing, or release timing. Insights must stay within the bounded scope of what was actually discussed.
- **When in doubt, output less.** It is better to return "Insufficient signal to draw conclusions" or "General Discussion" than to fabricate a confident-sounding insight. Honesty about uncertainty is mandatory; confident hallucination is a P0 bug.
- **This rule applies to every layer of every LLM pipeline:**
  - Topic-label humanization: the human label must use only words/concepts present in the raw keyword cluster.
  - Executive summaries: claims must be grounded in the topic labels and counts actually provided; no inferring business model, pricing, audience, or strategy from absence or from related-sounding labels.
  - Recommended actions: every action must respond to an evidenced topic; no boilerplate for things the data didn't surface.
  - Bold ideas: speculation about products/strategy is allowed, but the trigger insight must be evidence-backed.
- **Implementation expectation:** prompts must explicitly forbid hallucination with negative examples, and pre-LLM filters must drop ambiguous/short/sarcastic content into a neutral bucket that is excluded from summary inputs.

### 14. Context-Aware Attribution — Never Conflate Post Subject with Game Properties (always-on, all projects, all data pipelines)
**Hard, firm requirement for every pipeline that classifies, clusters, summarizes, or attributes properties to an entity (game, product, person, company, etc.) based on user-generated content.**

A post mentioning a topic, genre, mechanic, or property does NOT mean the entity the post is filed under shares that topic, genre, mechanic, or property. Posts arrive from general communities (r/gaming, r/pcgaming, etc.) and frequently reference OTHER entities for comparison, nostalgia, recommendation, or context. Treating any word in any post as a property of the focal entity is a hallucination, full stop.

- **Genre, mechanics, business model, platform, art style, and tone are properties of the entity — not of the post.** If a user post about Game A mentions Game B's horror elements, that signal does NOT belong to Game A's summary. Period.
- **Before attributing any topic to an entity, verify the post is ABOUT that entity, not merely MENTIONING it.** A relevance check at ingestion is mandatory: posts must either (a) come from an entity-specific source (a game's official subreddit, a product's vendor page, an artist's official feed), or (b) demonstrate substantive on-topic content (the entity name appears as a distinctive noun phrase, not as a passing reference; the post discusses the entity's actual content/features/issues, not just nostalgically name-drops it).
- **When a general-source post mentions multiple entities, do NOT cross-pollinate properties.** Mention of "Survival Horror games" in a thread that happens to include the focal entity's name does not make the focal entity a survival horror game. Topic clusters built from such posts must be discarded or the post must be excluded from clustering.
- **Use entity-genre awareness as a sanity gate.** Each entity has known properties (genre, business model, platform, target audience) recorded in the system. Any AI-generated topic label or summary claim that conflicts with the entity's known properties is a hallucination by definition and must be rejected.
- **Never assume genre transfer from related entities.** If users discuss the focal entity alongside titles from a different genre, that comparison reveals interest in cross-genre play patterns — not that the focal entity shares the other genre's properties. Frame such signals carefully or exclude them entirely.
- **Implementation expectation:** ingestion pipelines must include a per-post relevance filter that drops off-topic posts before they reach topic clustering. Summary prompts must include the entity's known properties as ground truth and forbid extrapolating beyond them.

This principle is the natural extension of §13 (No Inventing, No Speculating) into the data layer: §13 prevents the LLM from fabricating concepts; §14 prevents the upstream data from FEEDING the LLM contaminated material in the first place.

### 15. Critical Mass Before Surfacing — No Topic Bubbles Up Without Plural Independent Signal (always-on, all projects, all aggregation pipelines)
**Hard, firm requirement for every pipeline that surfaces topics, issues, opportunities, sentiments, or recommendations to a user.**

1-2 posts do NOT mean "this is how players feel" or "this is what users care about." Real signal looks like the same theme repeating across MULTIPLE independent authors over time. Pipelines must enforce a critical-mass threshold before a topic qualifies for inclusion in any summary, recommendation, bold idea, or trend report.

- **Minimum thresholds (all must be met) for a topic to surface in any user-facing output:**
  - **≥3 distinct posts** referencing the topic (not 3 mentions in the same thread — 3 separate top-level posts or distinct comment threads)
  - **≥3 distinct authors** — one user posting three times is one voice, not three
  - **Sustained presence** — the topic appears in posts across multiple days within the reporting window (not a single-day spike that's likely a news/release artifact)
- **Below threshold = excluded entirely.** A topic that almost qualifies is still noise. Do not surface it with a caveat ("this is emerging", "low-volume signal"). Do not surface it at all. Honesty about uncertainty means saying nothing about it, not saying it tentatively.
- **This applies symmetrically to positive AND negative topics AND bold ideas.** A single ecstatic post does not justify amplifying that aspect of the product. A single complaint does not justify recommending an action. A bold idea triggered by one post is not a bold idea — it's a guess.
- **Window-aware thresholds:** the absolute minimums above apply to the standard monthly summary. Shorter windows (7-day) may use proportionally lower thresholds but never below ≥2 distinct authors AND ≥2 distinct posts. Longer windows (90-day, all-time) should scale UP — a topic with only 3 posts over 90 days is not a trend.
- **Total-volume gate:** if the entire reporting window has <20 posts of substantive content, the pipeline should surface a single "insufficient signal for confident reporting" state. Do NOT attempt to find topics in a desert and call them trends.
- **Implementation expectation:** topic extraction at ingestion must record per-cluster post-count and author-count metadata. Summary prompts must receive ONLY clusters that pass the critical-mass gate. The gate enforcement lives in the data layer — not as a soft hint to the LLM — because the LLM will dutifully write confident prose about whatever clusters it's handed.

Together with §13 and §14, this completes the trust chain: §13 forbids inventing concepts; §14 ensures the posts are actually ABOUT the entity; §15 ensures the topics derived from those posts have enough plural independent support to count as real signal.

### 16. Auto-Deploy via GitHub Actions (TARGET)
Matches the howmanyareplaying.com project's `.github/workflows/deploy.yml` pattern.

- Once configured, merging to `main` automatically triggers a deploy on the droplet: pull, install deps, build, restart services. No manual `ssh + git pull + systemctl restart` needed.
- The workflow uses `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` secrets on the GitHub repo.
- For the Saber Suite droplet (104.236.239.46), the workflow should: SSH in, pull, run the apps' build commands, and restart only the affected services (sentimentpulse / signalpulse / triptracker / gtmstudio / nginx).
- Avoid the howmanyareplaying "stale DNS IP 502 bug" pattern — force-reload nginx after each rebuild.
- Until auto-deploy is wired up, the manual `bash deploy.sh` flow remains the deploy step.

### 17. Reddit Fetch Command — Canonical (CRITICAL — NEVER GUESS, NEVER SUBSTITUTE)

The ONE AND ONLY PowerShell command to fetch Reddit posts through the user's residential IP is:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\sentimentpulse\reddit_fetcher\fetch_reddit.ps1"
```

**Rules — non-negotiable:**
- Whenever the user (or any future user) asks for the PowerShell command to fetch Reddit posts, give THIS EXACT COMMAND verbatim — no alternatives, no "or you could also try", no `python fetch_and_upload.py` substitutes.
- Reddit blocks datacenter IPs (the droplet and GitHub Actions runners). The user runs this command from their home PC because their residential IP is not blocked.
- Do NOT invent variants. Do NOT propose alternative scripts. Do NOT suggest running it on the droplet. Do NOT suggest a Python-only invocation.
- If the command returns 403s in execution (Reddit-side block), diagnose the 403 — do NOT substitute a different command.

This rule exists because alternatives have been offered in error before. Any deviation is a regression.

### 18. Sentiment Trust Chain — No Confident Label Without Sufficient Signal

A post's sentiment label is only as trustworthy as the textual signal under it.  Misclassified labels poison topic clusters, summaries, and recommendations downstream — just like §13 / §14 / §15 protect against fabricated, off-topic, or low-volume insights, §18 protects against confident sentiment labels that the underlying text does not support.

**Hard rules — enforced at the data layer in `nlp_service.classify_with_gate()`:**

1. **Signal-volume gate.** Count substantive tokens (alphabetic words ≥ 3 chars, after stopword removal).
   - 0–2 substantive tokens → force `neutral`, score = 0.5.
   - 3–6 substantive tokens → classify but cap the stored score at 0.6.
   - 7+ substantive tokens → classify normally.

2. **Language gate.** Detect language. Any post not detected as English (and we have no tuned multilingual model) → force `neutral`.

3. **Title vs body separation.** When both title and body ≥ 30 chars exist, classify each independently.
   - Labels match → final label = same, final score = `min(title_score, body_score)`.
   - Labels disagree, **and** the title is a rhetorical question (ends with `?`, body ≥ 100 chars) → **body wins**.
   - Labels disagree, no rhetorical signal → body wins (longer signal), final score capped at 0.65, set `sentiment_conflict = true`.

4. **Confidence floor — strict 0.70.** After all prior steps, if final confidence is below 0.70, demote the label to `neutral` and record the original label in `original_label` for audit. This is non-negotiable. The user explicitly chose the strict threshold over moderate (0.60) and light (0.55) options.

5. **Gaming-domain lexicon overlay (PR #11).** A YAML rule file `backend/services/sentiment_rules.yaml` overrides the model on patterns the model is known to get wrong (rhetorical bug-list questions, praise emoji + body confirmation, etc.). Each rule fires deterministically and is logged per post for audit.

**Audit columns added to `sentiment_records`:**
- `signal_quality` (`low` / `medium` / `high`) — from the signal-volume gate
- `language` (ISO 639-1) — from langdetect
- `original_label` — the model's pre-floor label, when demoted
- `sentiment_conflict` (boolean) — set when title and body disagreed
- `applied_rules` (JSON list) — lexicon rules that fired

**Reclassification.** Every time §18 logic changes materially, all historical posts must be reclassified end-to-end (`backend/reclassify_all_sentiments.py`). The user explicitly chose this over "only new posts" so historical summaries and topic_trends remain consistent with current labelling.

**Why this matters.** A confident wrong label is worse than no label — it drives recommendations, bold ideas, and executive summaries in the wrong direction. §18's job is to ensure every label we ship is *supported by its text*.

### 19. End-to-End Ground Truth — Never Declare Success on Intermediate Signals (CRITICAL — always-on)

**A success claim is only valid when the user-facing or persistent state has been DIRECTLY verified.** Intermediate signals — log lines, fetch counters, ring buffer entries, HTTP 200s, "the function returned posts", green CI checks — indicate that a step ran. They do NOT confirm the goal was achieved.

The rule:

1. **Identify the ground truth for the claim** before declaring success. Examples:
   - "Ingest succeeded" → ground truth is **new rows in `raw_posts` with `collected_at >= run_started_at`**, not log lines saying "fetched N posts" and not the run-status field.
   - "Feature shipped" → ground truth is **the live URL renders the change**, not "deploy returned conclusion=success".
   - "Bug fixed" → ground truth is **the original failing user action now succeeds**, not "unit tests pass".
   - "Posts saved" → ground truth is **`SELECT COUNT(*)` returns the expected delta**, not `_bulk_save_posts` log line.
   - "Deployed" → ground truth is **a request to the live endpoint returns the new behavior**, not the GH Actions checkmark.

2. **Run the ground-truth query/check directly and paste the result before claiming success.** Never substitute a proxy. If the ground truth is a DB count, run the count query. If it's a rendered page, hit the URL. If it's a saved file, read the file.

3. **Especially after fixes to silent-failure code paths.** When the bug being fixed was "X ran but didn't persist", the post-fix verification MUST measure persistence — not just that the buggy step now reports "success". Counters, logs, and `_metric` lines are EXACTLY the signals that lied during the bug. They cannot be the proof of the fix.

4. **Differentiate "fetched" from "saved" in every observability statement.** "Arctic Shift returned 25 posts" is a fetch-side claim. "25 new rows landed in raw_posts" is the save-side claim. The first does not imply the second. Never use them interchangeably in any status report to the user.

5. **When the user reports the symptom is still present after a claimed fix, STOP and verify ground truth before any other action.** Do not propose a new fix, do not assume "transient" or "race condition", do not change scope. The user observed reality; the prior verification was insufficient. Re-verify with the actual ground truth and trace the gap.

**Anti-patterns this prevents (recorded as cautionary examples — see `lessons.md`):**
- **2026-05-29 Bluesky:** Claimed "2,167 posts saved across 26/28 games" based on dashboard endpoint counts and log lines saying `bluesky_metric posts=100 status=ok`. Did not run a DB-level count by `collected_at >= today_run_start`. Reality was correct here, but the verification process was unsafe — it would have missed the symmetric Reddit bug.
- **2026-05-30 Reddit:** Claimed "Reddit fetching successful" based on `arctic_shift_metric ... status=ok posts=25-49` lines in the ring buffer. Did not check whether any rows landed in `raw_posts`. The user noticed before I did. Zero rows had actually saved. The buffer's `status=ok` was a fetch-side signal, not a persistence signal.

**Why this is a CRITICAL principle, not a guideline.** Declaring a broken thing fixed compounds: the next bug investigation starts from a false premise. The user loses trust in every subsequent claim. And in a data pipeline specifically, a quiet wrong claim means real data is missing from analyses for as long as it takes for someone to notice independently.

### 20. Confirm-or-Omit — Never Invent Context, Only Confirm It Explicitly (CRITICAL — always-on, every summary, every recommendation, every bold idea)

**Hard, firm, no-exceptions requirement directed by the user 2026-06-24 after the Hellraiser/Jamie Clayton fabrication.**

The rule, verbatim from the user:

> *"On SentimentPulse summaries NEVER invent context, only confirm context explicitly. If you can't confirm do not create an issue positive or negative from the posts we are accumulating."*

In operational terms:

1. **Every claim in every summary, every recommended action, and every bold idea must be confirmable against a specific post in the source data fed into that LLM call.** Confirmable means: the agent could point at the exact post(s) — title + body — that establish the claim. If you cannot point to the post, the claim does not get made.

2. **No background knowledge is admissible.** Franchise history, prior games, movies, lore, voice actors from other adaptations, parent-company catalog, genre conventions, competitive titles, business model assumptions — none of these are valid inputs to the output. Only the post corpus actually passed to the prompt is admissible. If Doug Bradley is in the posts and Jamie Clayton is not, the model writes about Bradley or it writes nothing about casting.

3. **No issue, positive or negative, gets surfaced from posts that don't confirm it.** This is the symmetric form of the rule. An ambiguous post does not become a positive signal because the franchise has good buzz. A complaint about an unrelated game does not become a negative signal for the focal entity. If a post does not confirm the issue specifically and unambiguously, that issue does not exist for the purposes of this output.

4. **The output of "nothing to say" is preferred over the output of "something invented".** When evidence is thin: write less. Drop the section. Respond NONE. The cost of saying nothing is bounded. The cost of saying something fabricated is unbounded — it misleads strategy and erodes trust in every other summary.

5. **This applies to ALL three LLM calls in `period_summary_service.py`** (`_call_exec`, `_call_actions`, `_call_bold_ideas`) AND to any future prompt added to the project. The shared `_anti_fabrication_clause()` helper is the mechanical enforcement. New prompts must invoke it.

**Anti-patterns this prevents:**
- **2026-06-24 Hellraiser / Jamie Clayton:** Live digest cited "Jamie Clayton voice casting" as a Recommended Action and proposed partnering with her in a Big Idea. Ground truth: zero posts mentioned Clayton; one post explicitly said "Doug Bradley returns to voice Pinhead." The LLM autocompleted Clayton from background knowledge of the 2022 Hulu film. The exec-summary prompt's anti-fabrication clause caught it (the summary correctly stayed generic — "voice casting preferences" without naming a person), but the actions + bold-ideas prompts had no such constraint and freely invented her. Fix: shared `_anti_fabrication_clause()` invoked from all three prompts plus this §20 rule promoting confirm-or-omit from a prompt-level instruction to a project-wide requirement.

**Relationship to §13, §14, §15.** §13 said "no inventing concepts." §14 said "no conflating post subject with entity properties." §15 said "no surfacing without critical mass." §20 is the operational synthesis: **every individual surfaced claim must be confirmable, or it does not get surfaced.** §20 is the rule you check first; §13/§14/§15 explain why each class of violation is wrong.

**Implementation expectation.** Every prompt-builder in the codebase must, before asking the LLM to surface anything, inject an anti-fabrication clause that (a) restricts valid entities to the data shown, (b) forbids background knowledge, (c) provides a fallback to NONE when data is thin. Regression tests must assert the clause is in the prompt — not just that the *current* outputs happen to be clean.

### 21. Commercial Strategic Context — Amplify Positive Comparisons, Don't Counter-Position Away From Them (CRITICAL — always-on, every recommendation)

**Hard requirement directed by the user 2026-06-29 after the Hellraiser "counter-position away from Resident Evil" recommendation.**

The rule, in operational terms:

1. **Community comparisons to current commercial successes in the same genre are ASSETS, not liabilities.** When community posts compare the focal title to a market-leading entity (e.g. "reminds me of Resident Evil" when RE Requiem is the #1 commercial horror of 2026 with 7M+ units in 2 months), the market is telling the publisher the comparison resonates. The right play is **lean-into-and-add ("yes-and")** — amplify the comparison + add what makes the focal title authentic to its own IP. The wrong play is to advise the team to **counter-position, deflect, distance from, or distinguish from** that comparison.

2. **Every recommendation must be preceded by signal classification.** Before recommending an action on a community signal, the LLM must classify it as ASSET / LIABILITY / NEUTRAL. ASSETS get amplify-class verbs (Lean into, Amplify, Double down on, Anchor on, Spotlight, Embrace). LIABILITIES get address-class verbs (Patch — released games only, Clarify, Address, Document, Reframe). NEUTRAL signals don't get surfaced as recommendations.

3. **The per-title `commercial_context` field is the canonical source for what's an asset vs. a threat for each game.** Stored on `Game.commercial_context`. Read by every prompt via `_commercial_context_clause()`. Edited per title in the Settings UI on the per-title card. When unset, the prompt falls back to a generic "think commercially before counter-positioning" reminder.

4. **Defaults are bootstrapped for every active title** via `seed_commercial_context.py`. The user can override per title; the defaults are conservative and grounded in real 2026 commercial context (e.g. RE Requiem as horror benchmark, Halloween Sept 8 as asymmetrical threat for survival horror titles, live-service co-op as the format Space Marine 2 / Toxic Commando operate in).

5. **Removed `Counter-position` from the default verb list.** It was biasing the LLM to recommend distancing from positive comparisons. `Counter-position` remains valid only when explicitly named in the commercial-context brief as a named threat to differentiate from.

**Anti-pattern this prevents:**
- **2026-06-29 Hellraiser / Resident Evil counter-positioning:** Live weekly digest recommended "Counter-position Clive Barker's Horror Vision — reframe Revival as distinct… not competing with asymmetrical multiplayer alternatives" and a bold idea about *"not letting 'Modern Resident Evil wrapper' comparisons dominate discourse."* This advised the team to distance from the year's best-selling commercial horror property — strategically backwards. Fix: `_SIGNAL_CLASSIFICATION_CLAUSE` + per-title `commercial_context` brief + amplify-class verbs in the default list.

**Relationship to §20.** §20 is about *factual* grounding (every claim traceable to a post). §21 is about *strategic* grounding (every recommendation aligned with commercial reality). §20 stops you from inventing facts; §21 stops you from inventing strategy that contradicts commercial reality. They compose: a recommendation must be both factually grounded in posts (§20) AND strategically aligned with the title's commercial position (§21).

**Implementation expectation.** Every recommendation-generating prompt must inject `_commercial_context_clause(game.commercial_context)` AND `_SIGNAL_CLASSIFICATION_CLAUSE`. The default verb list MUST NOT include `Counter-position` outside of explicitly-named-threat scenarios. Regression tests must assert both clauses are present and that the default verb list is amplify-biased.

### 21c. The Critical-Mass Gate Applies to the Exec Summary, Not Just Recommendations (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the Hellraiser weekly digest exec led with "Regional localization gaps, particularly Turkish Community Posts" — a single-post monitor-only topic that §21b had already correctly suppressed from the recommendations.**

**Root cause:** `_call_actions` and `_call_bold_ideas` received `critical_mass_table` and the gate clause; `_call_exec` did not. The exec LLM was therefore free to lead with whatever topic looked salient even when §21b had classified that topic as too thin to act on. This is a worse failure than the one §21b was originally built to prevent, because the exec is what the user reads first.

**The rule.** Any prompt that produces user-facing analysis of community signal — exec summary, recommended actions, bold ideas, monthly digests, briefings — MUST be passed the `critical_mass_table` and MUST contain the leading-theme gate clause:

- The lead/headline sentence MUST describe a `theme`-tier topic, OR an overall mix observation when no theme exists.
- A `monitor-only` topic MUST NOT be the headline, dominant framing, or primary liability.
- Monitor-only topics MAY appear once in a supporting sentence as "worth watching" only.

**Implementation expectation.** A post-LLM `_strip_monitor_only_lead(text, monitor_topics)` validator runs after the prompt-level gate as belt-and-suspenders. Unit tests must cover: empty-input passthrough, no-monitor-topics passthrough, lead-dominated-by-monitor strip, incidental-mention preservation, only-sentence-was-lead-returns-empty.

**The principle.** A gate that lives only on the recommendations is a leaky gate. Anywhere the model writes about "what's happening in the community," the same critical-mass rules apply.

### 21d. Fragment-Lead Detector + Honest Placeholder Fallback (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the Space Marine 2 weekly exec opened with "109 negative), players consistently praise the tactile, visceral Space Marine fantasy...".**

**Root cause:** the `_strip_uncited_sentences` pass split the LLM output on sentence boundaries and dropped any sentence without a `[P-NNN]` citation. The LLM had written something like "Across 968 posts (233 positive vs 109 negative), players consistently praise..." — the first piece had no citation so it was dropped, exposing the second piece as the new lead with the matching `(` already sliced off.

**The rule.** Every prompt that runs through citation-stripping or sentence-level surgery MUST be followed by `_looks_like_fragment_lead(text)`. If the result opens like a mid-sentence fragment OR is entirely empty, drop to a clean analyst-voice placeholder via `_placeholder_summary()`. Never ship a sentence-fragment lead.

**Fragment signals** (any triggers fallback):
1. First alpha character is lowercase (mid-sentence continuation).
2. Lead matches an explicit fragment-opener regex (`and|but|or|so|because|which|while|though|whereas` + closing-paren/bracket/comma starts).
3. First sentence contains more closing parens/brackets than opening ones (the SM2 failure mode — matching `(` was sliced off).

**Honest placeholder requirement.** `_placeholder_summary(name, window, total_posts)` MUST produce analyst-voice prose, NEVER a config-error message. Two variants: "Insufficient signal for confident reporting (only N substantive posts in this window)." when below §15 threshold, OR "Community sentiment across N posts during {window} was mixed without a single dominant theme reaching critical mass. See topic breakdowns below for grounded detail by sentiment bucket." when above threshold. The previous `[AI summary unavailable — configure ANTHROPIC_API_KEY]` wording was leaking config-error language into production digests when sanitizers (not the API) failed.

### 21e. Orphan-Reference Filter Must Be Narrow (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the live digest showed 0 bold ideas across all 8 titles — a regression from the prior baseline of 1–2 bold ideas per substantive title.**

**Root cause:** `_ORPHAN_REFERENCE_PATTERNS` was too broad. It flagged any of: `this/that/the` + `analog|analogy|comparison|reference|approach|signal|entity|trend|pattern|issue|complaint|concern|topic|criticism|sentiment|demand|interest|reception|theme|narrative|argument`. Almost every community-marketing bold idea uses one of those nouns naturally (e.g. "capitalize on the demand for...", "address the issue of...", "lean into this trend"), and the filter was dropping every one as an "orphan reference."

**The rule.** Orphan-reference detection MUST be narrow. Only catch the tight anaphors that match the original L20 failure mode:

- `this/that` + `analog | analogy | comparison | reference` ONLY.
- Apply clause-boundary logic: an introducing verb (`rejected|preferred|compared|cited|named|mentioned|...`) must appear in a STRICTLY EARLIER clause to clear the orphan; same-clause is not enough.
- Routine noun phrases (`the demand`, `the trend`, `the issue`, `the complaint`, `the sentiment`) are NORMAL ENGLISH and must NOT be flagged.

**Implementation expectation.** Unit tests must include both positive cases (orphan `this analog` with no introducer = drop) and explicit negative cases (`Address the complaint` = keep, `lean into this trend` = keep, etc.).

### 21h. Narrow-Audience Theme Demotion (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the Hellraiser and Turok weekly execs led with "Regional Content Issues" / "Turkish Language Support" as broad-base liability themes — when in reality these were single audience-of-interest clusters that only crossed the §21b weight/day threshold because the same handful of Turkish-speaking posters were active across multiple days.**

**The rule.** A NEGATIVE or NEUTRAL topic label that names a specific locale, country, language, or single-SKU scope (Turkish/Spanish/Brazilian/etc.; "Regional Content Issues"; "Collectors Edition Spain") is force-demoted to monitor-only even if it crosses the §21b weight/day threshold.  The audience is too narrow for the topic to be a broad-base liability theme.

**Exception:** POSITIVE narrow-audience topics are NOT demoted.  A studio's deliberate localization play (Welsh VO on Bus Bound) generating community celebration IS a real marketing asset and a legitimate theme to amplify.

**Implementation expectation.** `_topic_is_narrow_audience(label)` matches a curated `_NARROW_AUDIENCE_MARKERS` list (40+ language/country/regional/SKU markers).  Adding a marker requires evidence of consistent narrow-audience scope; generic gaming nouns must NOT be added.

### 22b. Low-Rec-Count Single-Retry (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after Toxic Commando shipped 1 recommendation in the live digest despite 968 substantive posts and theme-tier topics available.**

**The rule.** When `_call_actions` produces fewer than `_REC_COUNT_MIN` valid recommendations on a substantive title (`total_posts ≥ _MIN_SUBSTANTIVE_POSTS`) with at least one theme-tier topic available, run ONE retry pass with an explicit fix-list hint injected at the top of the prompt naming the count gap ("your previous output had N items but the digest requires at least M").  Bounded to a single retry to avoid runaway LLM call counts.  If the retry produces fewer items than the first attempt, the original output is kept.

**Implementation expectation.** `_retry_actions_if_below_min()` is called inline within `_call_claude_for_period` after the first-pass `_call_actions`.  Unit tests must cover the three no-retry conditions (count at min, posts below substantive, no theme-tier topics) plus the retry-fires case.

### 22. Pre-Flight QA on Summary Outputs Before Asking The User To Approve (CRITICAL — always-on, every summary, every digest)

**Hard requirement directed by the user 2026-06-29 after the Toxic Commando / Turok / Bus Bound output had mechanically-detectable surface defects (orphan "However," opener, `1. [P-007]` empty-stub recommendations, sub-3 recommendation counts).**

**Rule.** Before persisting any summary row or sending any digest, run the pre-flight checklist in `lessons.md` (entry dated 2026-06-29 "Pre-flight QA checks"). If any check fails: attempt ONE regen with corrections injected into the prompt as an explicit fix-list, then re-validate. If still failing, drop the offending field rather than ship broken text. Never surface output with a mechanically-detectable defect; never ask the user "does this look right?" with an obvious surface bug present.

**The 12 checks:** orphan discourse-marker opener, empty exec above the §15 threshold, no surviving citations, empty-stub `1. [P-NNN]` recommendations, minimum 3 recommendations when data warrants, maximum 5, imperative-verb opener, bolded entity, no orphan pronouns in bold ideas, citation-plus-prose required on every idea, exec consistent with sentiment counts, no recommendations on monitor-only tier topics. Each check has a regression test.

**Implementation expectation.** Add `_validate_summary_output(row, critical_mass_table) -> list[ValidationFailure]`. Call from `generate_window_summary` and `generate_monthly_summary` after the LLM returns. Log every failure with its specific check name and the offending text. Tests must cover each of the 12 checks with a synthetic failure example.

**The principle.** Output quality bugs that are mechanically detectable should never reach the user. Asking the user to approve an output with an obvious surface defect is wasteful and erodes confidence.

### 23. Audit the deliverable, not the intermediate artifact (CRITICAL behavior rule)

**Hard requirement directed by the user 2026-06-29 after I shipped "§22 fix complete" twice and the user opened the email and found defects both times.**

**The failure pattern:** I was treating "the regen response JSON looks OK" as equivalent to "the user-facing deliverable looks OK." They are not the same. Today's session has three documented examples — §21 RE counter-positioning, §22 pre-flight QA, §22 format-contract — where I declared the fix complete based on intermediate audit, and the user found defects in the live deliverable.

**The rule:**

1. **Never declare a fix done by auditing intermediate artifacts.** The audit must consume what the user will see — digest preview HTML for digest changes, rendered React page for UI changes, the actual API JSON the frontend consumes for endpoint changes. Not the regen response JSON. Not the LLM output. Not anything upstream of the final render.

2. **Audit ALL titles and ALL surfaces touched by the fix, not just the one that triggered the report.** If the bug was on Hellraiser, the audit covers all 8. If exec + actions + bold + topics flow through the same code path, all four get checked. Today's bold-ideas regression — 0 across 8 titles — went undetected for two consecutive ship cycles because I never audited bold ideas at all.

3. **Write the acceptance criteria for the specific request BEFORE starting work.** Re-read the user's message; extract the exact requirements; write them as a checklist. Then audit each one explicitly. Implicit completeness assumptions are how silent regressions slip through.

4. **Audit the live deliverable AFTER deploy AND BEFORE telling the user.** Sequence: code → tests pass → push → deploy → re-fetch user-facing deliverable from production → audit against the written acceptance criteria → only then declare done.

5. **Any audit flag is a hard stop.** Do not minimize, do not explain it away, do not proceed to "send the digest" anyway. Fix, re-deploy, re-audit, repeat until truly clean.

6. **Never use "all clean," "complete," "shipped," or "fixed" until the user-facing deliverable is verified clean.** The cost of false claims is much higher than the cost of an extra audit pass.

7. **In the audit narrative, be specific about what was checked AND what was NOT.** "I audited X across all 8 titles and confirmed Y; I have NOT yet checked Z" is honest and useful. "All 8 clean ✓" without naming the surface is a lie waiting to be discovered.

**This rule supersedes any expedience consideration.** When in doubt, audit more. When the user has already caught one defect in this work item, audit far more before next ship.

### 25. Verified Evidence — Every Inferred Claim Must Quote A Source (CRITICAL — supersedes all)

**Hard requirement directed by the user 2026-06-29 after the Hellraiser weekly exec confabulated "IP licensing conflicts with competing Hellraiser titles in the asymmetrical multiplayer space" — a claim with ZERO evidence in any post, in any editorial article body, or in commercial/demographic context.**

**The pattern §25 closes.** Sessions §20 / §21 / §22 / §24 / §24e each tried to fix anti-fabrication after a specific bad output. The failure recurred each time, in a new shape, because every layer was checking "is the cited entity *mentioned* in the cited source?" — not "is the *specific claim* directly supported by the source's *quoted text*?". The LLM was constructing false narratives around real cited material and the per-sentence critic was rubber-stamping them because the entity overlapped.

**The rule (absolute).**

1. **A claim is HARD or COMMUNITY-OBSERVED. Treat each kind differently.**

   - **HARD claims** assert that something is true ABOUT THE WORLD: a competing title exists, a partnership has been announced, a comparable game launched on date X, an IP-licensing dispute is active, a publisher reported Y revenue, a demographic skews Z%, a regulatory event happened, a market event occurred. These are factual assertions independent of any commenter's opinion or wish.

   - **COMMUNITY-OBSERVED claims** describe what posters in this window are *saying, asking for, wishing, expressing, comparing, requesting, fearing, celebrating, or feeling*: "community is asking for Turkish localization," "posters wish the Tek Bow returns," "players compare it favorably to Doom," "community is split on difficulty," "users request a roadmap." These describe sentiment / desire / framing, not external-world fact.

2. **HARD claims must be backed by a quoted passage from a cited [P-NNN] post or [E-NNN] editorial body.** Topical adjacency is not enough. "The post mentions Hellraiser" does NOT support "there are competing Hellraiser titles in asymmetrical multiplayer." The supporting passage must contain the claim's specific factual substance. If no such passage exists, the claim is dropped.

3. **COMMUNITY-OBSERVED claims are valid when the cited source contains the corresponding community statement.** Examples that ARE legitimate:
   - "Community is asking for Turkish localization [P-004]" — because P-004 contains a Turkish-language request, even though no real Turkish version has been announced.
   - "Posters wish weapon-nostalgia nods like the Tek Bow return [P-011]" — because P-011 expresses that wish, even though no announcement confirms a Tek Bow.
   - "Players compare Origins favorably to Doom-like fast gunplay [P-006]" — because P-006 makes that comparison.
   These are valid even though no external real-world fact has been verified — the post IS the evidence of community sentiment, and the claim accurately reports what the community said.

4. **The framing distinction is mandatory.** A community wish must be framed as a community wish, not as an industry fact.
   -  Correct: "Community is asking for Turkish localization."
   - Incorrect: "Turkish localization is launching." (Hard claim; needs an editorial body confirming it.)
   - Correct: "Posters call out IP-licensing concerns about other Hellraiser games being made."
   - Incorrect: "There are competing Hellraiser titles in the asymmetrical multiplayer space." (Hard claim about competitor existence; needs a cited source that confirms it; if none, drop.)

5. **The verifier asks both questions per sentence:**
   - (a) What kind of claim is this — HARD or COMMUNITY-OBSERVED?
   - (b) If HARD: quote the supporting passage from a cited source that confirms the external-world fact, or respond UNSUPPORTED. If COMMUNITY-OBSERVED: quote the supporting passage from a cited post that contains the matching community statement, or respond UNSUPPORTED.
   Sentences whose claims come back UNSUPPORTED are dropped.

6. **"I cannot confirm this in the sources" — DROP the sentence.** Per §20 rule 4: the output of "nothing to say" is preferred over the output of "something invented." Per §25: confidence comes from the source quote, not the LLM's plausibility judgment.

7. **This applies to ALL three LLM output blocks** (exec_summary, recommended_actions, bold_ideas) and to ALL user-facing summary prompts in this project, including app-side per-day summaries.

8. **Implementation contract.** A `_verify_claims_against_sources(text, citation_map)` gate runs as the FINAL layer on exec, recs, and bold ideas (after parse, strip-uncited, critic, sanitize, orphan-strip, grounding). The verifier prompt MUST require quoted passages — not yes/no — because forcing a quote makes confabulation impossible to fake. The prompt MUST distinguish HARD vs COMMUNITY-OBSERVED so legitimate community-wish framings (Turkish localization request, Tek Bow nostalgia) are preserved.

9. **The verification gate is not optional.** Disabling it for cost or speed is not acceptable. The cost of a hallucinated digest is unbounded — it misleads strategy and erodes trust in every other summary. The cost of N extra LLM calls per digest is bounded.

10. **Diagnostic infrastructure is permanent.** `_verify_claims_against_sources` records a trace entry per call (input text, per-sentence HARD/COMMUNITY-OBSERVED classification, supporting quote or UNSUPPORTED, dropped sentences) visible at `/api/diagnostics/verification-trace`. The trace is how the user audits a digest's grounding without reading every source post.

11. **Test contract.** §25 regression tests must include:
    - One positive HARD case: a HARD claim that IS quoted verbatim in the source survives.
    - One negative HARD case: `test_confabulation_competing_titles_dropped` — "competing Hellraiser titles exist" must be dropped because no source contains the factual claim.
    - One positive COMMUNITY-OBSERVED case: `test_community_wish_preserved` — "community asks for Turkish localization" must survive when a cited post contains the request.
    - One negative COMMUNITY-OBSERVED case: an invented community sentiment (no post contains the matching statement) must be dropped.

**Relationship to §20.** §20 said "every individual surfaced claim must be confirmable." §20's gates checked for the *presence* of an entity in cited sources — a necessary but insufficient condition. §25 strengthens this to: the *substance* of the claim must be confirmable, demonstrated by a quoted passage. §20 was right in spirit and incomplete in mechanism. §25 is the operational closure.

**Anti-patterns this prevents (each is a real shipped defect this session):**

- **2026-06-29 Hellraiser / competing titles confabulation:** Exec said "IP licensing conflicts with competing Hellraiser titles in the asymmetrical multiplayer space [P-004, P-015]". The cited posts contained the word "Hellraiser" but did NOT claim competing titles exist. The per-sentence critic approved because the entity overlapped. §25 forces the critic to quote the supporting passage; no passage exists; sentence dropped.

- **2026-06-29 Turok / Turkish-language star confabulation:** Exec & rec #4 elevated "Turkish language support" to a primary surface claim despite being a single-poster signal (P-004 only). §21h had already demoted it to monitor-only at tier-assignment time, but the LLM still cited it because the post existed. §25 forces verification AND §25-companion rule below: monitor-only-tier topics may not become a primary surface claim regardless of LLM compliance.

- **2026-06-24 Hellraiser / Jamie Clayton fabrication (historical):** §20 closed this at the entity layer. §25 would also close it at the claim layer.

**Companion rule — monitor-only topics get a post-LLM rec gate.** A `_strip_monitor_only_recs(rec_text, critical_mass_table)` gate drops any numbered recommendation whose bolded entity or topic-label substring matches a monitor-only entry in the critical-mass table. Symmetrical to `_strip_monitor_only_lead` for exec. Without this, a single-poster topic (Turkish, Spanish, Brazilian, etc.) leaks into the rec list as a low-stakes "Clarify" or "Communicate" item that doesn't deserve top-N surface area.

**Pre-ship readback requirement (applied always when verification gates are new or under review).** Before declaring a fix done after a §25-class defect, the agent must quote each exec sentence + each rec line + each bold idea back to the user with the supporting source passage cited inline. "All clean" without the source quotes is not acceptable. This satisfies both §23 (audit the deliverable) and §25 (verify against sources).

### 25d. Monitor-only topics must not lead the surface (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the Hellraiser weekly exec twice shipped with "Turkish Language Support" as the top positive topic when it was a single-poster monitor-only signal.**

**The rule.** A topic that §21b / §21h have classified as `monitor-only` in the critical-mass table MUST NOT appear in the leading position of the `pos_str` / `neg_str` / `neu_str` strings shown to the exec LLM, NOR in the "Top positive topic" / "Top negative concern" line of the §24e grounded placeholder.  Monitor-only labels may appear in the trailing position of the displayed list (so the LLM has the full picture) but must not be the headline.

The critical-mass table tiers each topic as `theme` or `monitor-only`.  Theme-tier topics are broad-base community signal; monitor-only topics are real but too thin (single poster, single day, narrow audience).  The exec headline must be drawn from theme-tier topics; if none exist, the placeholder says so honestly rather than promoting a monitor-only label to the lead.

**Implementation expectation.** `_call_claude_for_period` reorders `pos_topics`/`neg_topics`/`neu_topics` so theme-tier labels come first and monitor-only labels are pushed to the end.  `_placeholder_summary` walks the same critical-mass table to pick the lead label; when no theme-tier label exists in a bucket, the placeholder must NOT cite a monitor-only label as "Top positive topic."  Unit tests must include the Hellraiser shape (Turkish leading the positive bucket, demoted to monitor-only by §21h) and assert the exec headline does NOT name Turkish.

### 25e. Exec summary must cover high-level themes across post buckets, biased toward user posts (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29: "EXEC SUMMARIES MUST contain a summary of the topic high level topics and context across user posts and editorial but bias toward user posts."**

**The rule.** Every executive summary above the §15 substantive-post threshold must:

1. **Cover at least 3 distinct theme-tier topics** drawn from the positive, negative, and neutral buckets (not all 3 must be present — e.g. a window with no negative theme tier topic is fine — but the exec must span at least 3 surface-worthy topics in total across whichever buckets have them).
2. **Bias toward user-post evidence.** Cite [P-NNN] community posts as the primary source for sentiment, framing, and what posters are saying.  Editorial citations [E-NNN] are SUPPLEMENTARY — used to add context (release timing, comparable launches, industry framing the posts reference) when an editorial article supports it.  An exec that cites only editorial without grounding in posts FAILS this rule.
3. **Convey both sides** when both exist.  If the bucket has both positive theme topics and negative theme topics with at least one substantive post each, the exec must reflect both — not be a one-sided amplification or a one-sided complaint.
4. **Be light prose, not a topic enumeration.** Exec summary is narrative — it weaves topics into 3-5 sentences of analyst voice, not a bulleted list and not a series of restatements of topic labels.
5. **Recommended actions and bold ideas SHOULD relate to the exec themes when possible.** Not strictly required (per user direction: "it can also speak to positive and negative trends in posts for the time period or other relevant general observations"), but the default is alignment.

**Implementation expectation.** `_validate_summary_output()` (§22 pre-flight) is extended with a `_exec_covers_min_themes` check: after the verifier runs, the surviving exec must reference at least 3 distinct theme-tier topic labels from the critical-mass table.  When it doesn't, run ONE retry with a fix-list hint naming the missed themes.  If the retry still fails, fall through to the grounded placeholder (which is allowed to be terse).

The exec prompt itself names this constraint explicitly: "Your summary MUST span at least 3 distinct theme-tier topics drawn from the positive/negative/neutral buckets above; do NOT lead with a single topic; bias toward [P-NNN] community posts as evidence; cite [E-NNN] editorial articles only when adding context the posts alone don't provide."

### 24. Editorial-Research Hybrid Bold Ideas (CRITICAL — always-on)

**Hard requirement directed by the user 2026-06-29 after the bold-ideas pipeline was producing post-anchored amplifications only — unable to generate speculative cohort-reach ideas grounded in real-world editorial context.**

**The rule.** Bold ideas may anchor on EITHER a `[P-NNN]` community post citation OR an `[E-NNN]` editorial citation drawn from a per-title press/analyst coverage cache.  Each idea MUST cite at least one of the two.  Pure invention without any citation remains forbidden.  Speculative reasoning about cohorts, IP-awareness gaps, and demographic plays IS allowed when the underlying signal is supported by a cited post or editorial article.

Exec summary and recommended actions remain post-citation-only (strict §20) — only bold ideas use the hybrid rule.

**Editorial cache schema** (`editorial_articles` table): one row per (game_id, scope, cycle_start, url).  scope is `'weekly'` or `'monthly'` (separate caches per user decision).  Each row holds the article URL, headline, lead-paragraphs body, LLM-generated single-paragraph evidence summary, and a sequential `E-001`, `E-002`, ... cite tag assigned per cycle.

**Search source.** Google News RSS (no API key, no auth) with query `"{game_name}" gaming` and a `when:Nd` recency filter (30d weekly, 90d monthly).  Custom User-Agent per §17.  Trusted publications (IGN, Polygon, Eurogamer, Fangoria, etc.) ranked first; dedupe by publisher domain; target 7 articles per cycle.

**Demographic context.** Per-title `games.demographic_context` TEXT column holds a brief describing target cohorts and IP-awareness gaps.  Used by the bold-ideas prompt to ground speculative cohort-reach reasoning.  Editable via PATCH `/api/games/{id}` and seeded for the 8 priority titles via `POST /api/games/seed-demographic-context`.

**Renderer.** `[E-NNN]` markers render as superscript anchor links to the article URL (label `E1`, `E2`, ... to distinguish from post citations).  Each title section ships an "Editorial context (§24)" footer listing up to 5 articles consulted, with publication + headline + link.

**Implementation expectation.** `editorial_research_service.py` exposes `fetch_editorial_for_title(db, game_id, scope, cycle_start, cycle_end)` — idempotent (cache-hit reuses existing batch).  Failure to fetch must NOT block the rest of the digest; `_safe_fetch_editorial()` catches any exception and returns `[]`.  Bold-ideas prompt branches on `editorial_articles` presence: when present, the prompt opens to speculative cohort reasoning + hybrid `[P/E]` citation; when absent, the prompt falls back to the strict §20 anchor-in-posts rule.

## Task Management
1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

<!-- END PRINCIPLES PROMPT COPY -->
---

## Canonical Principles

The canonical truth-and-accuracy, QA, and command-execution rules for this repo live in [`PRINCIPLES.md`](./PRINCIPLES.md). When in doubt, that file is the source of truth. Priority order on conflict: **Truth > QA > Style.**

The sections above contain project-specific operational details that remain in effect alongside `PRINCIPLES.md`.
