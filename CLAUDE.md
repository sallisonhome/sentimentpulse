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
- Auto-deploy on push to main is the goal (see Principle 12 below).

### 12. Auto-Deploy via GitHub Actions (TARGET)
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