"""2026-08-05 — Dashboard Top Topics widget: synthesize written feedback
sentences from the actual post corpus, not from Step 6's topic-label cluster.

Pipeline per user spec (2026-08-05 21:24 EDT):
  1. Pull SentimentRecords + RawPosts for the (game, period, sentiment) tuple.
  2. Filter to posts that express OPINION + SPECIFICITY \u2014 a clear like /
     dislike / wish / complaint that references a specific aspect of the
     game (mechanic, character, mode, patch, price, DLC, story beat).
     Drop pure hype, memes, one-word reactions, off-topic drift.
  3. Cluster survivors into distinct feedback themes.
  4. For the top 1-2 clusters by post-volume, synthesize ONE short sentence
     per cluster via Sonar Pro that captures what the cluster is saying.
  5. If nothing meets the bar: return empty. The widget renders
     \"Not enough posts with definitive signal to surface topics here.\"

Anti-fabrication contract (per lessons.md \u00a720 / \u00a725):
  * Sonar is called with the strict-grounding system message.
  * The prompt passes the actual post texts, tagged [P-001]..[P-NNN], and
    requires the synthesized sentence to be supported by them.
  * We do NOT verify sentence-by-sentence here (too heavy for a 1-2
    sentence widget). If quality degrades, add a Sonar-based verify pass.

Caching:
  * (game_id, period, sentiment) -> (sentences, expires_at) in-memory
    LRU. TTL = 15 min. Refreshes hit LLM once per bucket per 15 min.
  * Empty results cached same as populated so we don't retry hopelessly.

Cost envelope:
  * 3 sentiments \u00d7 5 periods \u00d7 33 games = 495 possible cache keys.
  * TTL 15 min means at most 495 Sonar calls / 15 min = 33 calls/min if
    every user hit every game+period+sentiment combo in the window.
    In practice, a single active user viewing one game triggers 3 calls.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import RawPost, SentimentEnum, SentimentRecord

logger = logging.getLogger(__name__)


# ── Filter: "opinion + specificity" ────────────────────────────────────────
#
# A post survives if it contains BOTH:
#   * An OPINION marker: a word/phrase that signals like/dislike/wish/complaint.
#   * A SPECIFICITY marker: reference to a concrete game aspect (mechanic
#     name, character, mode, patch, class, price, DLC, story beat).
#
# The specificity marker is inherently game-agnostic \u2014 we can't hardcode
# every mechanic name across the portfolio. Instead we use structural
# signals: reasonably-long noun phrase, capitalization suggesting a proper
# noun, common gaming-domain markers (patch, class, mode, mechanic, price,
# balance, DLC, chapter, boss, weapon, etc.).

_OPINION_MARKERS = re.compile(
    r"\b("
    # Positive
    r"love|loved|loving|amazing|incredible|great|awesome|fun|enjoy|enjoyed|"
    r"praise|impressed|solid|nailed|hooked|addicted|hyped|best|"
    # Negative
    r"hate|hated|disappointed|frustrating|frustrated|broken|terrible|awful|"
    r"unfair|bad|worst|garbage|trash|nerf|nerfed|regret|refund|"
    # Wish / request
    r"wish|hope|would love|would like|please|need|needs|should|"
    r"pls|plz|fix|fixed|"
    # Question about a specific thing
    r"why does|why is|why isn't|when will|will there|is there|are there|"
    # Comparative
    r"compared to|better than|worse than|reminds me of|feels like|"
    # Complaint marker without a swear
    r"issue|problem|bug|glitch|crash|crashes|lag|laggy|"
    # Praise marker
    r"actually good|actually great|surprisingly good|underrated"
    r")\b",
    re.IGNORECASE,
)

_SPECIFICITY_MARKERS = re.compile(
    r"\b("
    # Structural game elements
    r"class|classes|weapon|weapons|mode|modes|map|maps|level|levels|"
    r"chapter|chapters|boss|bosses|enemy|enemies|mechanic|mechanics|"
    r"skill|skills|perk|perks|ability|abilities|"
    # Progression / economy
    r"prestige|level.\d+|xp|exp|grind|grinding|unlock|unlocks|"
    r"progression|reward|rewards|"
    # Balance / patch
    r"balance|patch|update|hotfix|nerf|nerfed|buff|buffed|meta|"
    # Story / setting
    r"story|plot|character|characters|writing|dialogue|voice|voice.acting|"
    r"lore|world|setting|"
    # Commercial / release\n"
    r"price|priced|pricing|dlc|expansion|season.pass|microtransaction|"
    r"launch|release|early.access|beta|alpha|"
    # Technical\n"
    r"performance|fps|framerate|optimization|graphics|"
    r"matchmaking|multiplayer|co.?op|coop|solo|singleplayer|single.player"
    r")\b",
    re.IGNORECASE,
)


def _has_opinion_and_specificity(text: str) -> bool:
    if not text:
        return False
    # Very short posts almost never carry both signals.
    if len(text) < 25:
        return False
    return bool(_OPINION_MARKERS.search(text)) and bool(_SPECIFICITY_MARKERS.search(text))


# ── Cluster: bag-of-noun-phrases ─────────────────────────────────────────

_STOPWORDS = set("""
a an and are as at be but by for from has have i if in is it its of on or
so than that the their them there they this to was we were will with you
your just really very much still even more most some any all not do does
did no yes ok okay well maybe game games play playing player players
one two three four five six seven eight nine ten first second third
""".split())

# 2026-08-06 (afternoon): also block generic modals / light verbs / temporal
# fillers that carry no semantic content but appear across many posts.
# Without this, labels like "Can", "Get", "Come", "Now" leak through even
# though they say nothing about a specific game aspect.
_LIGHT_VERBS = set("""
can cant can't cannot could couldnt couldn't may might must ought
get got getting gets gotten give given giving gave gives
go goes going went gone come came comes coming
see saw seen seeing seem seems seemed
know known knew knowing think thought thinking
take took taken taking make made makes making
say said says saying tell told telling
find found finding
now then here there always never sometimes often always today tomorrow
someone anyone everyone nothing something anything everything
""".split())
_STOPWORDS.update(_LIGHT_VERBS)

# 2026-08-06 (evening, follow-up): after the light-verb + game-name pass,
# ground-truth audit showed labels still leading with interrogatives,
# conjunctions, contractions, and generic actor nouns:
#   SM2 positive:   "It's"       (contraction)
#   SM2 negative:   "Because"    (conjunction)
#   Halo MCC neu:   "What", "Why", "Mcc" (interrogatives + own-name)
#   Halloween pos:  "People"     (generic actor)
#   Halloween neu:  "Who"        (interrogative)
#   SH Townfall:    "How"        (interrogative)
#
# Same structural class of bug as "Like/Can/Get": category-wide vocabulary
# that carries no game-specific meaning but appears in nearly every post.
# Add each category to the stopword set BEFORE clustering.
_INTERROGATIVES = set("""
what why who how where when which whose whom
whats what's whys why's whos who's hows how's whats what's
""".split())
_CONJUNCTIONS = set("""
because since though although while whereas however moreover furthermore
nevertheless nonetheless therefore thus hence otherwise instead
meanwhile similarly likewise conversely accordingly consequently
btw fwiw imo imho tbh idk yea yeah nope nah
""".split())
_CONTRACTIONS = set("""
its it's thats that's theres there's heres here's
theyre they're were we're youre you're
id i'd hed he'd shed she'd wed we'd theyd they'd
ill i'll hell he'll shell she'll well we'll theyll they'll
ive i've youve you've hes he's shes she's
""".split())
_GENERIC_ACTORS = set("""
people person everybody everyone somebody someone anybody anyone
nobody noone folks guys guy dude dudes friend friends man men
woman women kid kids child children family families team teams
""".split())
# Note: some of these (someone, anyone, everyone, nothing, something) are
# already in _LIGHT_VERBS — duplicates in set unions are harmless.
_STOPWORDS.update(_INTERROGATIVES)
_STOPWORDS.update(_CONJUNCTIONS)
_STOPWORDS.update(_CONTRACTIONS)
_STOPWORDS.update(_GENERIC_ACTORS)

# 2026-08-06: block opinion-marker words from becoming cluster LABELS.
#
# The opinion+specificity filter admits a post only if it contains one of
# these words — so by construction they appear in ~every survivor. If
# they're eligible to be labels, they'll dominate the ngram count and
# produce useless labels like "Like" or "Need" under a Negative bucket
# (which is where the user caught this on 2026-08-06 morning). Add them
# all to the stopword set BEFORE clustering so labels reflect specific
# game aspects (matchmaking, prestige grind, krak grenades) instead.
#
# Kept as a separate list so future edits to _OPINION_MARKERS pattern
# stay reviewed against this list — both must move together.
_OPINION_MARKER_WORDS = set("""
love loved loving amazing incredible great awesome fun enjoy enjoyed
praise impressed solid nailed hooked addicted hyped best
hate hated disappointed frustrating frustrated broken terrible awful
unfair bad worst garbage trash nerf nerfed regret refund
wish hope please need needs should pls plz fix fixed
issue problem bug glitch crash crashes lag laggy
good actually surprisingly underrated
like liked liking had have has want wanted wants seem seems seemed
would could should like
""".split())
_STOPWORDS.update(_OPINION_MARKER_WORDS)

# Steam Community and Reddit boilerplate that appears verbatim across
# thousands of posts and would otherwise dominate the cluster labels
# (e.g. "originally posted by X", "edit:", "tl;dr"). Stripping these
# before phrase extraction gives the clusterer a fair shot at real
# content phrases.
_BOILERPLATE_PATTERNS = [
    re.compile(r"originally\s+posted\s+by[^:]{0,80}:", re.IGNORECASE),
    re.compile(r"^\s*edit\s*[:\-]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*tl;?dr\s*[:\-]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*update\s*[:\-]", re.IGNORECASE | re.MULTILINE),
    # Discourse quote prefixes
    re.compile(r"^>+\s*", re.MULTILINE),
    # Bare "originally" as a leading marker
    re.compile(r"\boriginally\s+posted\b", re.IGNORECASE),
]


def _strip_forum_boilerplate(text: str) -> str:
    if not text:
        return ""
    for pat in _BOILERPLATE_PATTERNS:
        text = pat.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()

_TOKEN = re.compile(r"[a-zA-Z][a-zA-Z\-']+")


def _game_name_tokens(game_name: str) -> set[str]:
    """Tokens from a game's title that should NOT appear as label heads.

    2026-08-06: labels like "Halo" or "Hellraiser" leaked through because
    the game's own name appears in almost every post about it. That's
    redundant — the widget lives on the game's own dashboard.
    Multi-word titles produce multiple stopword tokens (e.g. "Silent Hill
    Townfall" → {silent, hill, townfall}); we intentionally do NOT strip
    combined bigrams because we still want "Silent Hill Townfall" as a
    label when the whole title itself is what's being discussed (it's
    rarer and more meaningful than the individual tokens).
    """
    if not game_name:
        return set()
    return {
        w.lower() for w in _TOKEN.findall(game_name)
        if len(w) >= 3 and w.lower() not in {"the", "and", "of"}
    }


def _extract_content_ngrams(text: str, game_name_tokens: set[str] = frozenset()) -> list[str]:
    """Extract 1-3 word content phrases, lowercase, minus stopwords.
    Used as clustering keys so posts that mention the same feature phrase
    end up in the same cluster.

    2026-08-05: strip Steam/Reddit boilerplate ("originally posted by X:",
    "edit:", "tl;dr:", quote-block ">", etc.) BEFORE tokenising so those
    tokens don't dominate labels for games with heavy Steam-forum volume.

    2026-08-06: also strip individual game-name tokens ("halo", "hellraiser")
    so labels reflect specific aspects, not the redundant title. Whole-title
    bigrams/trigrams ("silent hill townfall") are preserved intentionally.
    """
    text = _strip_forum_boilerplate(text)
    words = [w.lower() for w in _TOKEN.findall(text)]
    _drop = _STOPWORDS | set(game_name_tokens)
    content = [w for w in words if w not in _drop and len(w) >= 3]
    ngrams: list[str] = []
    ngrams.extend(content)
    for i in range(len(content) - 1):
        ngrams.append(f"{content[i]} {content[i+1]}")
    for i in range(len(content) - 2):
        ngrams.append(f"{content[i]} {content[i+1]} {content[i+2]}")
    return ngrams


def _phrase_lead_is_valid(phrase: str, game_name_tokens: set[str]) -> bool:
    """Belt-and-suspenders: a cluster phrase must not LEAD with a stopword,
    a game-name token, or any word already banned above.

    The ngram extractor already strips these before phrases are built, but
    this guard exists so that a new leak class (whatever appears next in
    the wild) doesn't produce a broken label until a second commit lands.
    A phrase failing this check is simply skipped, and the clusterer falls
    through to the next-most-frequent phrase.
    """
    if not phrase:
        return False
    head = phrase.split()[0].lower()
    if head in _STOPWORDS or head in game_name_tokens:
        return False
    # Also require the head to be at least 3 chars — avoids weird 2-letter
    # abbreviations creeping in as label heads.
    if len(head) < 3:
        return False
    return True


def _cluster_posts_by_shared_phrase(
    posts: list[str],
    *,
    min_posts_per_cluster: int = 3,
    game_name: str = "",
) -> list[tuple[str, list[int]]]:
    """Group posts by the most-frequent content phrase they share.
    Returns [(cluster_phrase, [post_indices]), ...] sorted by volume desc.

    `game_name` is used to strip title tokens from label candidates so
    the widget doesn't surface the game's own name as its top label.
    """
    gtokens = _game_name_tokens(game_name)
    # For each n-gram, count how many DIFFERENT posts contain it.
    phrase_to_posts: dict[str, set[int]] = {}
    for i, text in enumerate(posts):
        seen: set[str] = set()
        for ng in _extract_content_ngrams(text, gtokens):
            if ng in seen:
                continue
            seen.add(ng)
            phrase_to_posts.setdefault(ng, set()).add(i)

    # Prefer multi-word phrases when they have similar volume to their
    # component unigrams \u2014 they are more specific.
    ranked = sorted(
        phrase_to_posts.items(),
        key=lambda kv: (-len(kv[1]), -kv[0].count(" "), kv[0]),
    )

    # Greedy assignment: consume post indices; a post enters the first
    # cluster whose phrase it contains. Phrases failing the lead-word
    # guard are skipped entirely (their posts remain available for the
    # next candidate phrase).
    used_posts: set[int] = set()
    clusters: list[tuple[str, list[int]]] = []
    for phrase, post_ids in ranked:
        if not _phrase_lead_is_valid(phrase, gtokens):
            continue
        available = [pid for pid in post_ids if pid not in used_posts]
        if len(available) < min_posts_per_cluster:
            continue
        clusters.append((phrase, available))
        used_posts.update(available)
    return clusters


# ── Sonar call: synthesize ONE sentence per cluster ─────────────────────

_SENTIMENT_VERBS = {
    SentimentEnum.positive: "praising",
    SentimentEnum.negative: "criticizing",
    SentimentEnum.neutral:  "discussing",
}


def _synthesize_cluster_sentence(
    game_name: str,
    sentiment: SentimentEnum,
    cluster_phrase: str,
    cluster_posts: list[str],
) -> Optional[str]:
    """Return a single short sentence describing what the cluster says.
    Returns None if Sonar isn't configured or the call fails \u2014 the caller
    handles that gracefully (renders the empty state).
    """
    from services.sonar_client import sonar_available, call_sonar

    if not sonar_available():
        return None

    # Cap the number of posts we ship to Sonar to keep the prompt small.
    # 10 posts per cluster is plenty of signal for a 1-sentence synthesis.
    sample = cluster_posts[:10]
    tagged = "\n".join(f"[P-{i+1:03d}] {text[:400]}" for i, text in enumerate(sample))
    verb = _SENTIMENT_VERBS[sentiment]

    prompt = (
        f"Game: {game_name}\n"
        f"Sentiment bucket: {sentiment.value}\n"
        f"Shared feedback phrase across these posts: {cluster_phrase!r}\n\n"
        f"Community posts (verbatim):\n"
        f"{tagged}\n\n"
        f"Task: In exactly ONE short declarative sentence (max 20 words), "
        f"describe what players are {verb} about a SPECIFIC aspect of the "
        f"game. Ground every claim strictly in the posts above. Do NOT "
        f"invent mechanics, characters, or details not in the posts. Do "
        f"NOT mention post IDs, citations, or brackets. Do NOT start with "
        f"filler phrases like 'Players are...' \u2014 lead with the specific "
        f"aspect. If the posts do not contain a coherent specific-aspect "
        f"opinion, output exactly: NO_COHERENT_SIGNAL\n\n"
        f"One-sentence output:"
    )
    try:
        # 2026-08-18: pass disable_search=True explicitly (also the default
        # in sonar_client) to lock in that this synthesis MUST be grounded
        # only in the cluster's actual posts. Prior to this fix, Sonar was
        # called with search_context_size="low", which still let it web-
        # search and blend live content. That produced a Turok: Origins
        # dashboard bullet full of Helldivers 2 patch-note vocabulary
        # ("shield mech", "flame sentry", "lumberer") even though Turok
        # is unreleased and its 19 admitted 7d posts contained no such
        # words. See lessons.md 2026-08-18.
        resp = call_sonar(
            prompt,
            max_tokens=80,
            temperature=0.2,
            disable_search=True,
        )
    except Exception as exc:
        logger.warning("Sonar call failed for game=%s sentiment=%s: %s",
                       game_name, sentiment.value, exc)
        return None

    text = (resp.text or "").strip()
    # Strip any surrounding quotes / trailing "One-sentence output:" echo.
    text = re.sub(r"^[\"'\s]+|[\"'\s]+$", "", text)
    text = text.split("\n")[0].strip()
    if not text:
        return None
    if text.upper().startswith("NO_COHERENT_SIGNAL"):
        return None
    # Belt-and-suspenders: strip any leaked [P-NNN] tokens.
    text = re.sub(r"\s*\[P-\d+(?:,\s*P-\d+)*\]", "", text)
    if len(text) > 240:  # sentence must stay short per spec
        text = text[:240].rsplit(" ", 1)[0] + "\u2026"
    return text


# ── Cache: per-(game, period, sentiment) → (sentences, expires_at) ──────

@dataclass
class _CacheEntry:
    payload: list[dict]
    expires_at: float


_CACHE: dict[tuple[int, str, str], _CacheEntry] = {}
_CACHE_TTL_SEC = 15 * 60


def _cache_get(key: tuple[int, str, str]) -> Optional[list[dict]]:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    if entry.expires_at < time.time():
        del _CACHE[key]
        return None
    return entry.payload


def _cache_set(key: tuple[int, str, str], payload: list[dict]) -> None:
    _CACHE[key] = _CacheEntry(payload=payload, expires_at=time.time() + _CACHE_TTL_SEC)


# ── Public API ─────────────────────────────────────────────────────────────


@dataclass
class TopicSummaryOut:
    label: str
    detail: str
    volume: int


def generate_feedback_summary(
    db: Session,
    game_id: int,
    game_name: str,
    sentiment: SentimentEnum,
    period_key: str,      # "today", "weekly", "monthly", "quarterly", "lifetime"
    period_start: Optional[date],
) -> list[TopicSummaryOut]:
    """Return 0-2 TopicSummaryOut for the (game, period, sentiment) tuple.

    Empty list means "no coherent feedback signal" \u2014 the widget renders
    'Not enough posts with definitive signal to surface topics here.'
    """
    cache_key = (game_id, period_key, sentiment.value)
    cached = _cache_get(cache_key)
    if cached is not None:
        return [TopicSummaryOut(**c) for c in cached]

    # 1. Pull posts in the window.
    #
    # 2026-08-18 (relevance-tier invariant fix): filter out noise-tier posts.
    # The 2026-07-24 comment on routers/dashboard.py said "a RawPost has a
    # SentimentRecord iff it passed the relevance gate at Step 5", but that
    # invariant is violated by services/ingestor.py Step 5: when the v3
    # relevance tagger marks a post 'noise', Step 5 falls back to the
    # older is_post_relevant_to_game() keyword gate. If the post's body
    # happens to name the game (very common for cross-posted comments in
    # competitor subs like r/Helldivers when the wrong subreddits are
    # attached to a game), the keyword gate admits it and a SentimentRecord
    # is created — but relevance_tier stays 'noise'. Turok: Origins had
    # 5,311 such noise-tier SentimentRecord rows in a 7d window (99.7% of
    # its 5,328 sentiment-classified posts), all from r/Helldivers, which
    # produced hallucinated Top Topics bullets full of Helldivers 2 patch-
    # note vocabulary even after Sonar web search was disabled. Filtering
    # here at the read side is defense-in-depth: any game with polluted
    # subreddit lists or leaky ingestion is protected until the underlying
    # data / Step 5 logic is repaired. See lessons.md 2026-08-18.
    #
    # Rationale for `!= 'noise'` (not `in ('signal', 'dedicated_sub')`):
    # 'unclassified' means the post predates the v3 tagger — those rows
    # should still count. Only explicit 'noise' verdicts are excluded.
    q = (
        db.query(RawPost.id, RawPost.title, RawPost.body)
        .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game_id,
            SentimentRecord.sentiment == sentiment,
            RawPost.post_date.isnot(None),
            (RawPost.relevance_tier.is_(None)) | (RawPost.relevance_tier != "noise"),
        )
    )
    if period_start is not None:
        q = q.filter(func.date(RawPost.post_date) >= str(period_start))
    rows = q.limit(2000).all()

    if not rows:
        _cache_set(cache_key, [])
        return []

    # 2. Filter: opinion + specificity.
    survivors: list[str] = []
    for _pid, title, body in rows:
        combined = f"{title or ''} {body or ''}".strip()
        if _has_opinion_and_specificity(combined):
            survivors.append(combined)

    if len(survivors) < 3:  # need at least one cluster of 3
        _cache_set(cache_key, [])
        return []

    # 3. Cluster (game_name passed so title tokens don't dominate labels).
    clusters = _cluster_posts_by_shared_phrase(
        survivors, min_posts_per_cluster=3, game_name=game_name,
    )
    if not clusters:
        _cache_set(cache_key, [])
        return []

    # 4. Synthesize top 1-2 by volume (runner-up rule: >= 70% of leader).
    top = clusters[:1]
    if len(clusters) >= 2 and len(clusters[1][1]) / len(clusters[0][1]) >= 0.70:
        top.append(clusters[1])

    out: list[TopicSummaryOut] = []
    for cluster_phrase, post_ids in top:
        cluster_texts = [survivors[i] for i in post_ids]
        sentence = _synthesize_cluster_sentence(
            game_name=game_name,
            sentiment=sentiment,
            cluster_phrase=cluster_phrase,
            cluster_posts=cluster_texts,
        )
        if not sentence:
            continue
        # Human-cased label from cluster phrase. Just title-case the words.
        label = " ".join(w.capitalize() for w in cluster_phrase.split())
        out.append(TopicSummaryOut(
            label=label,
            detail=sentence,
            volume=len(post_ids),
        ))

    _cache_set(cache_key, [dict(label=t.label, detail=t.detail, volume=t.volume) for t in out])
    return out
