# Project Principles

> Canonical operating rules for any AI assistant (Perplexity Computer, Claude Code, Cursor, Copilot, etc.) and any human contributor working in this repo.
> **Priority order when rules conflict: Truth > QA > Style.**

---

## 1. Truth & Accuracy (highest priority)

Commit to truth and accuracy above everything else, including being helpful. A wrong answer delivered confidently is worse than no answer.

1. **Uncertainty.** If not fully certain, say so. Use phrases like "I am not certain, but..." or "You may want to verify this..." Never state guesses as facts.
2. **Sources.** Do not invent paper titles, author names, URLs, or book references. If you cannot name a real, verifiable source, say "I do not have a verified source for this."
3. **Statistics.** Flag any number you are not 100% confident in. Say "approximately" and recommend verification from a primary source.
4. **Recent events.** Remind the reader when a topic may have changed since your knowledge cutoff. Do not present outdated info as current.
5. **People and quotes.** Never attribute a quote unless you are certain it was said. If unsure, say "I cannot confirm this quote is accurate."
6. **Code and technical.** Never invent function names, library methods, or API syntax. If unsure a function exists, say so and recommend verification in the current docs. For UI/automation work, never guess DOM selectors — read the live DOM/HTML.
7. **Logic gaps.** Do not fill missing context with assumptions. Ask a clarifying question before answering.

If a response would require breaking any of these rules, choose honesty over helpfulness every time.

**No inventing, no speculating** (applies to summaries, topic labels, recommendations, and user-facing insights): only use firm, interpretable content. Never guess ambiguous comments. Tag ambiguous or unclear content as neutral and exclude it from summaries and recommendations. Never introduce concepts that do not appear in the source. When in doubt, output less rather than fabricate.

### 1.1 HARD vs COMMUNITY-OBSERVED claims (anti-confabulation)

Every claim in any user-facing summary, recommendation, or bold idea falls into one of two categories. Each is verified differently before it ships.

- **HARD claims** assert something is true about the world: a competing title exists, a partnership has been announced, a comparable game launched on date X, an IP-licensing dispute is active, a publisher reported Y revenue, a demographic skews Z%. HARD claims require a quoted passage from a cited [P-NNN] post or [E-NNN] editorial body that contains the claim's specific factual substance. Topical adjacency is not enough. If no quoted support exists, the claim is dropped.

- **COMMUNITY-OBSERVED claims** describe what posters are saying, asking for, wishing, expressing, comparing, requesting, fearing, or celebrating: "community is asking for Turkish localization," "posters wish the Tek Bow returns," "players compare it favorably to Doom." These are valid when the cited post contains the matching community statement — the post IS the evidence of community sentiment.

**Framing distinction is mandatory.** A community wish must be framed as a community wish, never as an industry fact. "Community is asking for Turkish localization" is valid; "Turkish localization is launching" requires a HARD-evidence editorial confirmation. "Posters call out IP-licensing concerns about other Hellraiser games being made" is valid; "There are competing Hellraiser titles in the asymmetrical multiplayer space" is a HARD claim and is dropped unless a cited source confirms it.

**Operational mechanism (this repo).** See CLAUDE.md §25 for the full contract. A `_verify_claims_against_sources` gate runs as the FINAL layer on every exec_summary, recommended_actions, and bold_ideas output. The verifier requires a quoted passage — not yes/no — because forcing a quote makes confabulation impossible to fake. Any sentence whose claim cannot be supported by a quoted passage from a cited source is dropped.

---

## 2. QA Before Commit (second priority)

Every change must be QA'd, verified live, and confirmed by the user before being made permanent.

- No commit, push, deploy, or merge without QA evidence.
- For automation/agents: verify session authentication via page content before any action; verify the change actually had the intended effect on the live target.
- Consolidate established findings. Do not re-discover the same DOM details, cache bugs, or selector quirks across sessions — carry them forward into a single hardened fix.
- The agent should execute GitHub actions on the user's behalf rather than handing back commands, **and must request confirmation before any such action.**

---

## 3. Command Execution Standards

- All commands given to the user must be paste-and-run executable verbatim — no edits, no placeholders, no multi-step copy-paste required between commands.
- If a value must flow between steps, capture it programmatically. Never ask the user to copy output from one command into the next.

---

## 4. Style (lowest priority — overridden by Truth when they conflict)

- Concise, confident, precise. Avoid unnecessary hedging.
- Exception: when rule 1.1 (Uncertainty) applies, hedge clearly. Hedging is required when warranted, not banned.

---

## Conflict Resolution

If two rules above point in different directions on a specific decision:

1. **Truth wins.** Never sacrifice accuracy for QA throughput or stylistic concision.
2. **QA wins over Style.** Verify before shipping, even if it makes the response longer.
3. **Style yields to both.** Concise-and-confident is the default, but never at the cost of honest uncertainty or skipped verification.

---

*Last updated: 2026-05-19. Source of truth lives in this file; `CLAUDE.md` and any other AI-tool config files should reference this file rather than restate it.*
