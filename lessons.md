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

## 2026-06-28 — Pre-release "Patch Difficulty Settings" violation (CLAUDE.md §20 hardening)

**Violation.** A 7-day recommendation for Hellraiser: Revival (id=21) read:

> "Patch **Game Difficulty Settings** — negative sentiment concentrated here; balance pass required before October release window [P-021]"

Three independent §20 violations stacked:
1. **Wrong release context.** Hellraiser is unreleased; an unreleased game cannot be patched, balanced, or hotfixed.
2. **Wrong specific entity.** The cited post P-021 says only *"I'm disappointed in Hellraiser Revival after seeing actual gameplay. It's Hellraiser in window dressing only and what looks to be a very generic Resi-like."* — zero mention of difficulty settings.
3. **Fabricated date.** "Before October release window" is not in any cited post.

**Why all four layers missed it:**
- Layer 1 prompt rule (anti-fabrication) — restricted proper nouns, not verbs/dates.
- Layer 2 proper-noun fact-check gate — "difficulty", "settings", "October" are all common words, not proper nouns; gate didn't fire.
- Layer 3 citation grounding — the recommendation HAD a citation (`[P-021]`); the citation existed in the map; nothing to drop.
- Layer 4 self-criticism — the critic prompt's "topical proximity is not support" rule was apparently too soft. It accepted the recommendation because P-021 is a negative post about the game (topical proximity), without checking whether the specific mechanic (difficulty settings), date (October), or verb context (patch on an unshipped game) matched the post.

**Fix architecture (this commit):**

1. **Release-status heuristic.** `_infer_release_status(samples_block)` returns `"pre-release" | "released" | "unclear"` based on counts of pre-release signal words (trailer, reveal, wishlist, "after seeing gameplay", SGF, gamescom, etc.) vs. post-release signal words (patch, hotfix, server, matchmaking, prestige, season pass, etc.) in the sample posts. Directionally correct on every priority title; no DB schema change required.

2. **Layer 1 prompt augmentation.** A new `_release_status_clause(status)` is injected into all three prompts (exec, actions, bold). For pre-release: forbids Patch/Hotfix/Rebalance/Nerf/Buff/Revert; allows only Clarify/Communicate/Reframe/Address/Document/Publish/Reveal/Showcase/Reassure/Counter-position. For released: explicitly allows live-game verbs. For unclear: instructs caution.

3. **Layer 2b post-LLM sanitizer.** `_sanitize_recommendations_for_release_status(text, status)` drops any numbered recommendation whose item-line matches one of `_POST_LAUNCH_VERB_PATTERNS` when status is pre-release. Patterns cover leading verbs (patch/hotfix/rebalance/nerf/buff/revert/roll back/ship update), the phrase "balance pass", and "before <month> release". This is belt-and-suspenders — even if the LLM ignores the prompt and the critic accepts it, the regex drops it before persistence.

4. **Layer 4 critic prompt hardened.** Added three new explicit rules:
   - Specific mechanic/feature names (difficulty settings, matchmaking, weapon balance, etc.) must be literally named in the cited post; generic complaints don't count.
   - Dates, deadlines, release windows, and version numbers must be literally in the cited post; current date and industry knowledge are inadmissible.
   - Post-launch action verbs against pre-release context are auto-UNSUPPORTED.

**Tests** (test_anti_fabrication.py +14 tests): release-status detection (pre/post/unclear/empty), the sanitizer (patch/hotfix/rebalance, "balance pass", "before October release", noop for released/unclear, all-dropped-returns-empty), and the prompt clause shape. 537 passing total.

**What this does NOT fix:** the release-status heuristic is text-driven; it can be wrong on edge cases (live game with a heavily-marketed expansion announcement, beta with mostly trailer chatter, etc.). The proper long-term fix is a `Game.release_status` field administered per title. Until then, the layered defense ensures the failure mode is "be conservative on verb choice" rather than "fabricate a patch for an unreleased game."

---

## 2026-06-29 — Commercial strategic context (CLAUDE.md §21)

**Violation.** The Hellraiser weekly digest sent on 2026-06-29 contained:

> "Counter-position **Clive Barker's Horror Vision** — reframe Revival as distinct single-player experience, not competing with asymmetrical multiplayer alternatives, to resolve IP licensing perception concerns. [P-004, P-009]"

> Bold idea: *"...rather than letting 'Modern Resident Evil wrapper' comparisons dominate discourse."*

Both recommendations advised the team to distance the game from comparisons to Resident Evil. Resident Evil Requiem (Feb 27 2026) is the year's #1 commercial horror release — 7M+ units in 2 months, fastest-selling RE ever, Metacritic 89-92. **A community comparison to that property is a commercial GIFT**, not a problem to deflect. The system advised the strategic opposite of what a competent commercial PM would say.

**Why §20 didn't catch it.** §20 enforces factual grounding (every claim traceable to a post). The recommendation WAS factually grounded — there really are community posts comparing Hellraiser to RE. §20 has no opinion on whether the *strategic interpretation* of that grounded claim is commercially sensible.

**The missing layer.** The system had no concept of **strategic grounding** — whether a recommendation is aligned with commercial reality. It treated every community signal as a thing to "react to" (address, counter-position, deflect, distinguish from) without ever asking: **is this signal a commercial ASSET or LIABILITY?**

**Fix architecture (CLAUDE.md §21):**

1. **Per-title `commercial_context` field on `Game`.** Free-form 4-6 sentence brief naming: positioning, commercial tailwinds to amplify, threats to differentiate from, and a "DO NOT" clause to make verb selection explicit. Read by the summary LLM via `_commercial_context_clause()`. Editable in the Settings UI on the per-title card.

2. **`_SIGNAL_CLASSIFICATION_CLAUSE` injected into every prompt** (exec, actions, bold). Forces the LLM to classify each community signal as ASSET / LIABILITY / NEUTRAL before recommending an action, and explicitly maps verb classes: ASSET → amplify verbs (Lean into, Double down on, Anchor on, Spotlight, Embrace). LIABILITY → address verbs (Patch [released only], Clarify, Address). NEUTRAL → no recommendation.

3. **Default verb list rewritten.** Removed `Counter-position` from the recommended verbs in `_call_actions`. Amplify-class verbs moved to the front of the list. `Counter-position` is now reserved for explicitly-named threats in the commercial-context brief, not as a default deflection move.

4. **Default briefs seeded for all 8 priority titles.** `seed_commercial_context.py` ships defensible defaults grounded in real 2026 commercial context (RE Requiem as horror benchmark, Halloween Sept 8 as asymmetrical threat for survival-horror titles, Space Marine 2 as live-co-op proof point, etc.). Idempotent — won't overwrite user-edited briefs.

5. **Tests** (`test_anti_fabrication.py` +10 tests, 556 passing total): brief-set vs. unset behavior, signal classification clause shape, seed coverage of all 8 priority titles, Hellraiser default specifically names RE as tailwind and Halloween as threat, all default briefs include a DO NOT clause.

**Operational principle (commit to memory).** When a community signal references a current commercial success in the same genre, the default interpretation is **the market is validating the comparison; amplify it**. Counter-positioning is reserved for explicitly-named threats in the brief (e.g. asymmetrical horror vs. single-player survival). When the brief is silent, the LLM falls back to a generic "do not advise distancing from a comparison to a market-leading title in the same genre" reminder. This is a strategic decision rule, not just a prompt heuristic — adopt it for every future PM-style output the project generates.

---

## 2026-06-29 — Pre-flight QA checks before asking the user to approve / send

User pattern noticed across the §20 / §21 / §21b iterations: the agent kept producing summary outputs with surface-level oddities (orphan "However,", empty citation-only recommendations, single-poster-driven recommendations, recommendation counts below the 3-minimum target, etc.) and asking the user to approve them — instead of catching them mechanically before declaring the work done.

**Rule going forward.** Before sending any user-facing summary content (real-time UI render OR digest email), run the pre-flight checklist below. If any check fails, FIX it and re-verify; do not surface the output, do not ask the user to approve, do not declare the task complete.

### Pre-flight QA checklist for SentimentPulse summary outputs

Run this against every generated row (window summary, monthly summary) before persisting or shipping. Implement as a Python validator (`_validate_summary_output`) the user can re-use; the LLM call site invokes it and triggers a regen-once-with-stricter-prompt if any check fails. Hard failures (after one regen attempt) drop the offending field rather than ship broken text.

**Executive summary checks:**
1. **No orphan discourse marker as opener.** Must not start with "However,", "Moreover,", "Additionally,", "Furthermore,", "On the other hand,", "Nevertheless,", "Conversely,", "Meanwhile,", "In contrast,", "That said,", "Yet,", "But," — these only make sense following a preceding sentence. If layer-3 sentence stripping leaves one of these as the new opener, scrub the marker (and re-capitalize), OR drop the whole exec and regenerate.
2. **Non-empty when total_posts ≥ _MIN_SUBSTANTIVE_POSTS.** Below the §15 threshold the placeholder is correct; above it, an empty exec is a bug.
3. **At least one citation token survived** when citation_map is non-empty (otherwise every sentence got stripped — regen with a stricter "must cite" reminder).

**Recommendations checks:**
4. **No empty-stub items.** A numbered item that is just `1. [P-NNN]` or `2. [P-001, P-007]` with no prose between number and citations is a layer-3 artifact (LLM produced prose + cite, critic stripped the prose, citation survived alone). Drop these items; renumber survivors.
5. **Minimum 3 recommendations** when total_posts ≥ _MIN_SUBSTANTIVE_POSTS AND there is at least one theme-tier topic available. Below that, fewer is fine. If below minimum after all filters, regenerate ONCE with a stricter "produce N recommendations covering the breadth of the data" instruction; if still below, ship what we have.
6. **Maximum 5 recommendations.** If the LLM returns more, truncate to the top 5 by order.
7. **Every item starts with an imperative verb in the allowed verb list.** Items that start with "Note that..." / "It appears..." / "The community..." are not recommendations, they're observations. Drop or rewrite.
8. **Every item has a bolded entity or topic label.** Items without `**...**` formatting fail the format contract.

**Bold ideas checks:**
9. **No orphan pronouns** — already enforced by `_strip_orphan_reference_ideas`, but keep the check in the validator.
10. **Each idea has at least one citation token AND substantive prose.** Same empty-stub check as recommendations.

**Cross-field checks:**
11. **Exec text consistent with the counts.** If the exec says "overwhelmingly positive" but neg_pct > 30%, the exec is wrong. (Already partially enforced by the breakdown-numeric-reference rule in `_call_exec`.)
12. **No recommendations referencing topics in the monitor-only tier of the critical-mass table.** §21b enforcement — recommendations must only cite topics that cleared the recurrence threshold.

**Implementation expectation.** Add `_validate_summary_output(window_or_monthly_row, critical_mass_table) -> list[ValidationFailure]`. Call it from `generate_window_summary` and `generate_monthly_summary` after the LLM returns and before commit. On failure: log the specific check that fired, attempt ONE regen pass with the failures injected into the prompt as a corrections list, then re-validate. If still failing, drop the offending field (set to None) rather than ship broken text. Regression tests must cover each of the 12 checks with a synthetic failure example.

**The deeper principle.** Output quality bugs that are mechanically detectable should never reach the user. Asking the user "does this look right?" with an output that contains an obvious surface defect ("1. [P-007]" with no prose, or "However, X" with no preceding sentence) is wasteful of their attention and erodes confidence. The user explicitly asked for these checks to be encoded into the system; honor that by making them table-stakes for shipping any summary.

---

<!-- Add new lessons above this line, newest first. -->
