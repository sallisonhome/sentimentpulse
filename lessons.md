# Lessons Learned — Agent Working Notes

A running list of mistakes the agent has made on this project and corrective
rules to prevent them from happening again. Every entry references the
session date so future agents can reconstruct context.

---

## 2026-06-24 — Confirm-or-Omit Directive (permanent, project-wide)

**User directive, recorded verbatim:**

> *"on sentiment pulse summaries NEVER invent context, only confirm context explicitly. IF you can't confirm do not create an issue positive or negative from the posts we are accumulating. Commit this to lessons.md and the project requirements overall."*

**Status:** Promoted to CLAUDE.md §20 (Confirm-or-Omit) — a CRITICAL always-on requirement on the same tier as §13/§14/§15/§19. Every claim in every summary, recommended action, and big idea must be confirmable against a specific post in the source data fed into that LLM call. If a claim cannot be pointed to a specific post, the claim does not get made. No issue, positive or negative, is surfaced from posts that do not specifically and unambiguously confirm it. Saying nothing is preferred over saying something invented.

This is not a heuristic. It applies to every prompt currently in the project and every prompt added in the future. Mechanically enforced by `_anti_fabrication_clause()` in `backend/services/period_summary_service.py`, which is invoked from `_call_exec`, `_call_actions`, and `_call_bold_ideas`. Regression test: `backend/tests/test_anti_fabrication.py` asserts the clause is in each prompt — not just that current outputs happen to be clean.

The full operational rule lives in CLAUDE.md §20. This entry exists in lessons.md so the directive's exact wording and date are preserved in the agent's working notes alongside the failure that prompted it (see the Hellraiser/Jamie Clayton entry below).

---

## 2026-06-24 — LLM fabricated a celebrity name in the digest (anti-fabrication rule)

**What happened.** The live weekly digest for Clive Barker's Hellraiser: Revival surfaced "Jamie Clayton voice casting" as a Recommended Action and proposed partnering with Jamie Clayton in a Big Idea. The user caught it: Doug Bradley is the cast Pinhead voice actor in the game, not Clayton (Clayton played Pinhead in the 2022 Hulu film).

Ground truth from `raw_posts` for game_id=21 in the 7d window:

  - posts mentioning "Clayton": **0**
  - posts mentioning "Bradley": **1** ("Doug Bradley returns to voice Pinhead in Hellraiser Revival")
  - posts mentioning "Pinhead": 2 (both confirming Bradley)

The LLM autocompleted Clayton from background knowledge of the franchise's film history. The community didn't mention her. The model invented a celebrity name and used it as if it came from the data.

**Why this happened.** Three prompt functions feed Claude: `_call_exec`, `_call_actions`, `_call_bold_ideas`. The exec-summary prompt already had an explicit anti-fabrication clause ("Do NOT invent specifics that aren't in the samples or entities list") — and the resulting executive summary correctly stayed generic ("Minor friction surfaces around voice casting preferences"). But the actions + bold-ideas prompts had no such constraint. They told the LLM to "reference a SPECIFIC entity" but did not restrict the source of that entity to the input data. The model treated franchise background knowledge as fair game.

This is also a CLAUDE.md §19-shaped failure: an intermediate signal (the prompt asked for "specific entities") was treated as sufficient to guarantee fidelity, but the actual ground truth (the post corpus we fed in) was not enforced as the only valid source.

**Rule (permanent, no exceptions):**

Every prompt that asks Claude to surface named entities (people, characters, DLC, patches, modes, levels, weapons, voice actors, etc.) MUST include a clause that:

1. Limits valid entities to those appearing **verbatim** in the input data (sample posts or distinctive-entities list).
2. Explicitly forbids using **background knowledge** about the franchise, its prior games, its movies, its actors, or its lore.
3. Provides a fallback: if no proper-noun entity is in the data, fall back to a topic label or respond NONE.

This is implemented as a shared helper `_anti_fabrication_clause()` in `period_summary_service.py` and is now invoked from all three `_call_*` prompts. Regression test: `backend/tests/test_anti_fabrication.py` asserts (a) the clause is present in each prompt when data is supplied, (b) the prompt's data section contains only real entities from the input (no Clayton), and (c) the empty-data fallback "NO SPECIFICS AVAILABLE — do not invent" form is used when both samples and entities are empty.

**How to apply this rule going forward.** Whenever a new prompt function is added that synthesizes from community data into an analyst-facing output, the FIRST thing to add — before specificity preferences, before formatting rules, before the data section — is the anti-fabrication clause. The order is: identity → output style → anti-fabrication → task → data → format.

Written 2026-06-24 after the Hellraiser/Jamie Clayton fabrication was caught by the user. Commit: <hash>.

---

## 2026-06-24 — Verify domain ownership before suggesting DNS work (§19 violation)

**What happened.** During the Resend email-sender setup, the agent suggested using `mail.sentimentpulse.com` as the verified sending domain for the digest. Reasoning was: "the domain name matches the product name, so the user must own it." The agent then registered `mail.sentimentpulse.com` in the user's Resend account and prepared DKIM / SPF / MX records, all before checking whether the user actually owned `sentimentpulse.com`.

The user pushed back: "i thought we didn't reserve a domain like sentimentpulse.com for this site and are just relying on the IP address." Ground-truth check (`curl https://sentimentpulse.com/`, `dig +short A sentimentpulse.com`) revealed:

- The domain resolves to `15.197.225.128` / `3.33.251.168` (AWS Global Accelerator) — NOT the SentimentPulse droplet IP `104.236.239.46`.
- The domain serves an unrelated commercial product called "Sentiment Pulse | AI-Powered Stock Analysis."
- The user's actual SentimentPulse app lives only at `http://104.236.239.46/sentiment/` — a droplet IP path, no domain attached.

The agent had been about to walk the user through a 20-minute Cloudflare nameserver-switch + 3 DNS-record exercise on a domain they don't own.

**Why this happened.** The agent treated a *name match* as ownership evidence. It also conflated memory notes from `lifetime-class-booker` (which has its own domain setup) with SentimentPulse. The agent's mental model assumed every product has a matching domain, which is not how this user works — SentimentPulse is currently a droplet-IP-only deployment.

**Rule (permanent, no exceptions):**

Before suggesting ANY DNS work, domain configuration, registrar changes, or claiming a domain on behalf of the user, the agent MUST:

1. **Run `dig +short A <domain>` and `curl <domain>`** to see where the domain points and what it serves.
2. **Confirm with the user explicitly** that they own/control the domain. A name match ("sentimentpulse.com matches SentimentPulse") is NOT evidence of ownership.
3. **Check the actual production URL** the user uses to access the app, not the domain the agent assumed.

This is a specific instance of CLAUDE.md §19: ground truth must be verified before action, never assumed from naming coincidences. "Domain X exists with a related name" is an intermediate signal; "the user owns and controls Domain X" is the ground truth that authorizes DNS work.

The cost of guessing wrong here was bounded only because the user caught it. If the user had said "sure, sounds good" the agent would have walked them through a 20-min DNS-on-a-domain-they-don't-own exercise that would have failed at the very first step.

**What to do for transactional email when the user has no domain:**

- Either ask the user to pick + register a domain, OR
- Restrict the recipient list to only the Resend account owner's verified address (the no-domain-needed path), OR
- Use a domain the user has already verified ownership of (confirmed by an actual question and an actual whois / DNS check, not by name resemblance).

Written 2026-06-24 after the agent registered `mail.sentimentpulse.com` in Resend and had to delete it via `DELETE /domains/{id}` to clean up the mistake.

---

## 2026-05-30 — Never declare success on intermediate signals; verify ground truth

**Mistake (two confirmed instances, one detected by the user):**

1. **2026-05-29 Bluesky rollout.** Claimed "2,167 posts saved across 26/28 games" based on the dashboard endpoint and `bluesky_metric posts=100 status=ok` log lines. Did not run a direct DB count of rows where `collected_at >= run_started_at`. Reality happened to be correct, but the verification was unsafe — the same proxy would have missed an analogous Reddit failure.

2. **2026-05-30 Reddit cron diagnosis.** Earlier today's cron pulled 0 Reddit posts. While investigating, claimed "Reddit is working perfectly right now" after a manual ingest, citing `arctic_shift_metric ... status=ok posts=25-49` lines in the live ring buffer. The user pushed back and asked me to actually verify the claim. A direct DB count showed **zero** Reddit rows saved across all 28 active games today — despite Arctic Shift returning 25-49 posts per subreddit. The buffer's `status=ok` was a fetch-side signal; persistence was the actual question, and persistence was 0.

The second case is the harmful one. If the user had not pushed back, I would have built retry/notification infrastructure on top of a still-broken save path. The retry would never "recover" anything because the bug was never about fetch volume — it was about persistence dropping every post silently.

**Rule (now permanent, formalized as CLAUDE.md §19):**

Before declaring success on anything that produces persistent state, identify the **ground truth** of the claim and run the direct query/check that measures it. Specifically:

- **Ingest success** = `SELECT COUNT(*) FROM raw_posts WHERE source=? AND collected_at >= run_started_at`. Not log lines. Not status field. Not buffer counters.
- **Bug fix success** = the original failing user action now produces the expected outcome. Not "tests pass". Not "function returned non-empty".
- **Deploy success** = a fresh request to the live endpoint returns the new behavior. Not the green CI checkmark.

When the bug being fixed was "X ran but didn't persist", the post-fix verification MUST measure persistence — not that the buggy step now reports success. The signals that lied during the bug cannot be the proof of the fix.

Differentiate "fetched" from "saved" in every observability statement: those are two different facts and they are not interchangeable.

When the user reports the symptom is still present after a claimed fix, STOP and re-verify ground truth before proposing any new fix. Don't assume "transient". Don't change scope. The user observed reality.

See `CLAUDE.md` §19 for the full canonical rule.

---

## 2026-05-29 — Never ask the user to run a command without including the command

**Mistake (twice in one session, in the same debugging thread):**

While diagnosing the Reddit fetcher 403 errors, the agent asked the user to run a
PowerShell line and paste the output back — but did NOT include the actual command
in the message. The user had to ask for it before they could proceed.

**Rule (permanent, no exceptions):**

When the agent asks the user to run any command — in PowerShell, bash, cmd, a SSH
session, a browser console, anywhere — the agent MUST include the exact
copy-paste-ready command in the same message as a fenced code block.

Specifically:

- ✅ "Run this in PowerShell and paste the output:" followed by a `powershell`
  code block with the literal command.
- ❌ "Run this single line and paste back what you see." (no command provided)
- ❌ "Open PowerShell and run a curl test." (vague, not paste-and-run)

This is true regardless of which UI tool the agent is using (ask_user_question
with free_text_only, plain prose, confirm_action, etc.). If the prompt text
contains "run this" or "execute this" or any equivalent phrasing, a code block
with the command MUST be included beside it. Re-read the message before sending
to confirm the command is there.

This rule reinforces the broader user preference (already in memory) that all
commands given to the user must be complete, paste-and-run executable verbatim,
with no edits, no placeholders, and no copy-this-paste-that steps.

---

## 2026-06-24 — Citation grounding + self-criticism (CLAUDE.md §20 layers 3 + 4)

Two further defenses behind §20's prompt rule (layer 1) and post-LLM proper-noun fact-check gate (layer 2):

**Layer 3 — Citation Grounding.** Every sample post pulled into a summary prompt is tagged with a stable token `[P-001]`, `[P-002]`, ... The prompt requires every sentence (or numbered item, or bold idea) to end with at least one such citation drawn from the allowed list. Sentences without a valid `[P-NNN]` are dropped before the user sees them. The renderer turns each token into a small superscript anchor link to the source post URL, so every claim is auditable in the email itself.

**Layer 4 — Self-Criticism.** After each LLM call, a second Claude call ingests `(text, source posts cited)` and emits one SUPPORTED/UNSUPPORTED verdict per sentence. Unsupported sentences are stripped. Failure modes are degrade-safe: a critic-call exception or a malformed (length-mismatched) verdict list both keep the first-pass output rather than wipe everything.

**Why both, not one.** Layer 2 catches *fabricated proper nouns* (the Jamie Clayton case) but is blind to *semantic hallucination* — a claim that uses only real names but invents the relationship, direction, or quantity between them ("Doug Bradley criticized for the casting choice" when no post says that). Layer 3 forces the LLM to point at a specific post for every claim. Layer 4 verifies the cited post actually supports it. Together they close the semantic gap that proper-noun matching alone leaves open.

**Data model change.** `WindowSummary.citation_map` and `MonthlySummary.citation_map` are new nullable JSON columns (migration `0007_summary_citation_map.py`). The map persists `{ "P-001": { "id": post_id, "url": post_url, "sentiment": "positive" }, ... }` alongside the summary text so the email renderer can resolve tokens to clickable links at render time without re-querying. Rows pre-dating layers 3+4 have `citation_map = NULL`; the renderer treats null as legacy and silently strips any leftover `[P-NNN]` tokens.

**Tests** (`backend/tests/test_anti_fabrication.py` + `backend/tests/test_digest_service.py`):
  - Citation infrastructure: ID assignment, prompt-block formatting, requirement-clause shape, multi-cite extraction `[P-001, P-003]`, sentence drop, item drop with renumbering, bold-idea drop, no-op when citation_map empty.
  - Self-criticism: drops UNSUPPORTED, keeps SUPPORTED, no-op when citation_map empty, keeps first-pass on critic API error, keeps first-pass on malformed (length-mismatched) verdict output, item-level criticism, bold-idea-level criticism.
  - Renderer: single-cite → sup-link, multi-cite → multiple links, missing URL → plain superscript number, legacy null citation_map → tokens stripped, URL is HTML-escaped (& and ").

**Cost.** Layer 4 adds one additional Claude call per LLM output block (~3 extra calls per summary, one per `_call_exec/_call_actions/_call_bold_ideas`). This is the price of every sentence in a digest being verifiably grounded to a specific post the user can click through to.

---

## 2026-06-24 — Clayton "community demand signal" is grounded, not fabricated (don't over-correct)

**Context.** After deploying CLAUDE.md §20 layers 3+4 (citation grounding + self-criticism), the freshly-regenerated Hellraiser bold idea read:

> "Lean into **Jamie Clayton** voice casting as a community demand signal; early build praise for honoring source material creates opening to announce voice talent that deepens franchise authenticity and captures untapped fan enthusiasm. [P-002, P-004]"

The agent's first instinct was that Clayton had slipped through layer 2 again. Investigation showed otherwise:

- A 4-page (`page_size=200`) sweep of `/api/games/21/posts` returned 750 total posts, not the 50 originally inspected (the API has no `?days=N` parameter — the earlier filter was silently ignored).
- Among those 750 posts, **multiple Bluesky and Steam-forum posts explicitly discuss Jamie Clayton** as a community wish — e.g. post id 69772 ("I'd be way more interested in Hellraiser: Revival if Jamie Clayton was voicing Pinhead"), id 63346, id 42998, id 41061, id 21030, etc.
- The bold idea's citation `[P-002]` resolves to one of those real posts (`https://bsky.app/profile/foxenlock.bsky.social/post/3mok5xsykrc2i`), which a human can click and verify.
- The bold idea does NOT claim Clayton is cast. It frames her name as "community demand signal" and proposes the publisher acknowledge that demand. That is exactly the §20-compliant shape: confirm what posts actually say, do not invent that she is cast.

**Rule.** When §20-protected output mentions a name that the agent previously caught as fabricated, do NOT auto-revert. Re-check the actual posts in the full window against the cited [P-NNN] token. If the citation points to a real post that genuinely supports the framing (community wish, criticism, demand signal, controversy, etc.), the claim is grounded — leave it alone. The §20 violation is *inventing context*, not *naming a real entity that real posts discuss*.

**Concretely, this means:**

- Do not strengthen the proper-noun whitelist to exclude Clayton (or any other previously-flagged name). The whitelist is derived from the actual input data; if a name appears in the data, it is by definition a valid reference.
- Do not tighten the self-criticism prompt to demand "is the bold idea a marketing recommendation the company would actually take" — that conflates editorial judgment with grounding. Grounding is about whether the post supports the claim; whether the claim is wise is a separate dimension.
- The earlier Clayton failure (2026-06-24 morning) was a different shape: the LLM stated Clayton as if cast, with no post saying that. Layers 1+2 fixed that exact failure. Layers 3+4 fixed the broader semantic gap. The remaining Clayton mentions in today's digest are a feature, not a bug.

**Operational note for future agents.** When the user asks "does the data really say X?", run a full-window post sweep with `page_size=200` across all pages — do not trust a single-page response. The `/api/games/{id}/posts` endpoint paginates by `page_size` (default 50, max 200) and has filters for `sentiment`/`source`/`date_from`/`date_to` but NOT a `days` parameter. Earlier in this session the agent reported "0 posts mention Clayton in the 7d window" based on the default first page only — which was wrong by an order of magnitude.

---

<!-- Add new lessons above this line, newest first. -->
