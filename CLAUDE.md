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
