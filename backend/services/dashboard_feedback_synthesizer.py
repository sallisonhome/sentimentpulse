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

_TOKEN = re.compile(r"[a-zA-Z][a-zA-Z\-']+")


def _extract_content_ngrams(text: str) -> list[str]:
    """Extract 1-3 word content phrases, lowercase, minus stopwords.
    Used as clustering keys so posts that mention the same feature phrase
    end up in the same cluster.
    """
    words = [w.lower() for w in _TOKEN.findall(text)]
    content = [w for w in words if w not in _STOPWORDS and len(w) >= 3]
    ngrams: list[str] = []
    ngrams.extend(content)
    for i in range(len(content) - 1):
        ngrams.append(f"{content[i]} {content[i+1]}")
    for i in range(len(content) - 2):
        ngrams.append(f"{content[i]} {content[i+1]} {content[i+2]}")
    return ngrams


def _cluster_posts_by_shared_phrase(
    posts: list[str],
    *,
    min_posts_per_cluster: int = 3,
) -> list[tuple[str, list[int]]]:
    """Group posts by the most-frequent content phrase they share.
    Returns [(cluster_phrase, [post_indices]), ...] sorted by volume desc.
    """
    # For each n-gram, count how many DIFFERENT posts contain it.
    phrase_to_posts: dict[str, set[int]] = {}
    for i, text in enumerate(posts):
        seen: set[str] = set()
        for ng in _extract_content_ngrams(text):
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
    # cluster whose phrase it contains.
    used_posts: set[int] = set()
    clusters: list[tuple[str, list[int]]] = []
    for phrase, post_ids in ranked:
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
        resp = call_sonar(prompt, max_tokens=80, temperature=0.2, search_context_size="low")
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
    q = (
        db.query(RawPost.id, RawPost.title, RawPost.body)
        .join(SentimentRecord, SentimentRecord.raw_post_id == RawPost.id)
        .filter(
            RawPost.game_id == game_id,
            SentimentRecord.sentiment == sentiment,
            RawPost.post_date.isnot(None),
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

    # 3. Cluster.
    clusters = _cluster_posts_by_shared_phrase(survivors, min_posts_per_cluster=3)
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
