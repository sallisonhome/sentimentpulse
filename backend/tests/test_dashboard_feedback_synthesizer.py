"""2026-08-05 — Dashboard Top Topics widget rebuilt to synthesize written
feedback sentences from the actual post corpus (opinion + specificity
filter → cluster → Sonar one-sentence synthesis).

These tests cover the deterministic pieces of the synthesizer and stub
Sonar at the boundary so we don't hit the network during unit tests.

Contract (per user spec 2026-08-05 21:24 EDT):
  1. Filter drops posts without opinion + specificity signal.
  2. Cluster groups survivors by shared content phrase, gated at 3
     posts per cluster.
  3. Top 1 cluster synthesized by default; runner-up when its volume
     is >= 70% of the leader's.
  4. Empty result when < 3 survivors OR no cluster clears the gate.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from services.dashboard_feedback_synthesizer import (
    _cluster_posts_by_shared_phrase,
    _extract_content_ngrams,
    _has_opinion_and_specificity,
)


# ── Filter: opinion + specificity ──────────────────────────────────────────

class TestOpinionSpecificityFilter:
    def test_opinion_plus_specificity_passes(self):
        text = "I love the class balance in this patch, feels much better"
        assert _has_opinion_and_specificity(text) is True

    def test_opinion_without_specificity_fails(self):
        # Has "love", "amazing" but no specific mechanic/feature name.
        text = "I love this game so much, it's amazing"
        assert _has_opinion_and_specificity(text) is False

    def test_specificity_without_opinion_fails(self):
        # Mentions "prestige" / "weapon" but no like/dislike/wish.
        text = "The game has prestige levels and multiple weapons"
        assert _has_opinion_and_specificity(text) is False

    def test_very_short_post_fails(self):
        # Under 25 chars, drop even if both signals theoretically present.
        text = "love the buff"
        assert _has_opinion_and_specificity(text) is False

    def test_meme_style_hype_fails(self):
        text = "PEAK. absolute cinema. GOTY confirmed"
        assert _has_opinion_and_specificity(text) is False

    def test_complaint_with_specificity_passes(self):
        text = "The matchmaking is broken, keeps putting me against Prestige 5 players"
        assert _has_opinion_and_specificity(text) is True

    def test_wish_with_specificity_passes(self):
        text = "I really hope they add Turkish language support in the next patch"
        assert _has_opinion_and_specificity(text) is True

    def test_question_about_specific_mechanic_passes(self):
        text = "Why does the campaign story feel so short compared to the first game"
        assert _has_opinion_and_specificity(text) is True

    def test_empty_string_fails(self):
        assert _has_opinion_and_specificity("") is False

    def test_none_fails(self):
        assert _has_opinion_and_specificity(None) is False


# ── Clustering ─────────────────────────────────────────────────────────────

class TestClustering:
    def test_dominant_phrase_wins(self):
        posts = [
            "prestige grind is way too long, needs a rework",
            "the prestige grind killed my motivation to play",
            "prestige grind should be reduced by half",
            "matchmaking is broken",  # different theme, only 1 post
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        assert len(clusters) == 1
        phrase, post_ids = clusters[0]
        assert "prestige grind" in phrase
        assert len(post_ids) == 3

    def test_multi_word_phrase_preferred_over_component_unigram(self):
        # If \"prestige grind\" and \"prestige\" have equal post counts, the
        # 2-word phrase wins because it's more specific.
        posts = [
            "prestige grind is bad",
            "prestige grind sucks",
            "prestige grind ruined the endgame",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        assert clusters
        phrase, _ = clusters[0]
        assert phrase == "prestige grind"

    def test_gate_enforced_min_3_posts(self):
        posts = [
            "prestige grind is bad",
            "prestige grind sucks",
            "matchmaking is broken",
            "matchmaking has issues",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        # Neither cluster has 3 posts, so no clusters survive.
        assert clusters == []

    def test_stopwords_do_not_form_clusters(self):
        # Common English words like "the", "is", "and" should NOT drive
        # clusters. Otherwise every post would cluster on stopwords.
        posts = [
            "the game is good and the mechanics are solid",
            "the game is fun and the story is deep",
            "the game is great and the combat is tight",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        # If clusters emerge at all, none of them may be stopword-driven.
        for phrase, _ in clusters:
            for word in phrase.split():
                assert word not in {"the", "is", "and", "a", "an"}, (
                    f"Stopword '{word}' formed a cluster \u2014 filter broken"
                )


# ── Public API: end-to-end with Sonar stubbed ─────────────────────────────

class TestGenerateFeedbackSummary:
    @pytest.fixture()
    def game(self, db):
        from models import Game, Publisher, RawPost, SentimentEnum, SentimentRecord, SourceEnum
        from datetime import datetime, timedelta, timezone, date
        from services import dashboard_feedback_synthesizer as m
        m._CACHE.clear()

        pub = Publisher(name="Test Pub")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=77771, name="Test Game",
            is_active=True, distinctive_keywords=["Test Game"],
        )
        db.add(g); db.flush()

        # 5 posts that hit the filter (opinion + specificity), all sharing
        # a content phrase → single cluster of 5.
        for i, body in enumerate([
            "The prestige grind is way too long, needs a rework badly",
            "Prestige grind ruined my motivation, please reduce it",
            "Prestige grind should be halved in the next patch",
            "Prestige grind is the worst part of the game",
            "The prestige grind feels like an unrewarding chore",
        ]):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit,
                external_id=f"gr_{i}", body=body, is_relevant=True,
                post_date=datetime.now(timezone.utc) - timedelta(days=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.9,
                topics=[],
            ))
        db.commit()
        return g.id, "Test Game"

    def test_synthesizes_when_signal_is_present(self, db, game):
        gid, gname = game
        from datetime import date, timedelta
        from services.dashboard_feedback_synthesizer import generate_feedback_summary
        from models import SentimentEnum

        with patch("services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
                   return_value="Players want the prestige grind shortened."):
            out = generate_feedback_summary(
                db=db, game_id=gid, game_name=gname,
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )
        assert len(out) == 1
        assert "prestige grind" in out[0].label.lower()
        assert out[0].detail == "Players want the prestige grind shortened."
        assert out[0].volume == 5

    def test_empty_when_no_posts(self, db, game):
        gid, gname = game
        from datetime import date, timedelta
        from services.dashboard_feedback_synthesizer import generate_feedback_summary
        from models import SentimentEnum

        # Neutral sentiment has no posts on this game → empty.
        # Also clear cache from any prior test.
        from services import dashboard_feedback_synthesizer as m
        m._CACHE.clear()

        out = generate_feedback_summary(
            db=db, game_id=gid, game_name=gname,
            sentiment=SentimentEnum.neutral,
            period_key="monthly",
            period_start=date.today() - timedelta(days=30),
        )
        assert out == []

    def test_empty_when_sonar_returns_none(self, db, game):
        # Sonar unavailable or returned NO_COHERENT_SIGNAL → cluster
        # produces no output.
        gid, gname = game
        from datetime import date, timedelta
        from services.dashboard_feedback_synthesizer import generate_feedback_summary
        from models import SentimentEnum
        from services import dashboard_feedback_synthesizer as m
        m._CACHE.clear()

        with patch("services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
                   return_value=None):
            out = generate_feedback_summary(
                db=db, game_id=gid, game_name=gname,
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )
        assert out == []


class TestCacheTTL:
    def test_cache_hit_avoids_second_sonar_call(self, db):
        # After a first call populates the cache, a second call with the
        # same (game_id, period, sentiment) must NOT invoke Sonar again.
        from models import Game, Publisher, RawPost, SentimentEnum, SentimentRecord, SourceEnum
        from datetime import datetime, timedelta, timezone, date
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()
        pub = Publisher(name="P")
        db.add(pub); db.flush()
        g = Game(publisher_id=pub.id, steam_app_id=77772, name="CacheGame", is_active=True)
        db.add(g); db.flush()

        for i in range(4):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit, external_id=f"c_{i}",
                body="Prestige grind is too long, needs a patch to reduce it",
                is_relevant=True,
                post_date=datetime.now(timezone.utc) - timedelta(days=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id, sentiment=SentimentEnum.negative,
                sentiment_score=-0.9, topics=[],
            ))
        db.commit()

        call_count = {"n": 0}
        def _stub(**_):
            call_count["n"] += 1
            return "Prestige grind is too long."

        with patch("services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
                   side_effect=lambda **kw: _stub(**kw)):
            generate_feedback_summary(
                db=db, game_id=g.id, game_name=g.name,
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )
            generate_feedback_summary(
                db=db, game_id=g.id, game_name=g.name,
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )
        # Second call must be a cache hit \u2014 Sonar stub invoked exactly once.
        assert call_count["n"] == 1


# ── Boilerplate stripping (2026-08-05 followup) ─────────────────────────

class TestFollowUpLeaksBlocked:
    """2026-08-06 (evening follow-up): after the light-verb + game-name pass,
    ground-truth check surfaced new leak classes:
      * Interrogatives: What, Why, Who, How, Where, When
      * Conjunctions: Because, Since, Though, However, Actually
      * Contractions: It's, That's, There's
      * Generic actors: People, Everyone, Someone

    All four are structural (whole-vocabulary-category present in nearly
    every post) — same shape as the earlier leaks. Add each category to
    the stopword set BEFORE clustering.
    """

    @pytest.mark.parametrize("forbidden", [
        # Interrogatives
        "what", "why", "who", "how", "where", "when", "which",
        "whats", "what's",
        # Conjunctions / discourse markers
        "because", "since", "though", "although", "while", "whereas",
        "however", "moreover", "therefore", "instead",
        "btw", "tbh", "imo",
        # Contractions
        "its", "it's", "thats", "that's", "theres", "there's",
        "theyre", "they're",
        # Generic actors
        "people", "person", "everyone", "everybody", "someone",
        "folks", "guys", "dude", "family", "team",
    ])
    def test_new_leak_class_word_not_in_ngrams(self, forbidden):
        from services.dashboard_feedback_synthesizer import _extract_content_ngrams
        text = f"{forbidden} the matchmaking design in this patch update"
        ngrams = _extract_content_ngrams(text)
        assert forbidden not in ngrams, (
            f"leak-class word {forbidden!r} still reaches ngrams; "
            f"add it to the relevant _INTERROGATIVES / _CONJUNCTIONS / "
            f"_CONTRACTIONS / _GENERIC_ACTORS set."
        )

    def test_end_to_end_cluster_label_not_interrogative(self):
        """Even if 'What' is the most-frequent shared word across posts,
        the cluster must fall through to the specific-aspect phrase."""
        from services.dashboard_feedback_synthesizer import (
            _cluster_posts_by_shared_phrase,
        )
        posts = [
            "What is going on with the matchmaking, keeps giving me bots",
            "What happened to matchmaking, it puts me with Prestige 5",
            "What is wrong with the matchmaking today, terrible pairing",
            "What the hell, matchmaking is broken again",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        assert clusters
        top_label = clusters[0][0]
        assert not top_label.lower().startswith("what"), (
            f"interrogative-led label: {top_label!r}"
        )
        assert "matchmaking" in top_label.lower()

    def test_end_to_end_cluster_label_not_contraction(self):
        """Posts starting with contractions must not produce contraction labels."""
        from services.dashboard_feedback_synthesizer import (
            _cluster_posts_by_shared_phrase,
        )
        posts = [
            "It's the campaign story that hooked me, honestly incredible",
            "It's the campaign story pacing that impressed me the most",
            "It's the campaign story emotional beats that hit hardest",
            "It's the campaign story remaster quality that shines",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        assert clusters
        top_label = clusters[0][0]
        assert not top_label.lower().startswith("it"), (
            f"contraction-led label: {top_label!r}"
        )
        assert "campaign" in top_label.lower() or "story" in top_label.lower()


class TestPhraseLeadSafetyValve:
    """The _phrase_lead_is_valid function is the last-line safety valve.
    Even if a new leak class appears that isn't yet in any _STOPWORDS
    subset, this function must catch it before it becomes a widget label.
    """

    def test_valid_lead_word_passes(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        assert _phrase_lead_is_valid("matchmaking issues", set()) is True
        assert _phrase_lead_is_valid("prestige grind", set()) is True

    def test_stopword_lead_rejected(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        # 'the' is a base stopword.
        assert _phrase_lead_is_valid("the matchmaking", set()) is False

    def test_interrogative_lead_rejected(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        assert _phrase_lead_is_valid("what the hell matchmaking", set()) is False

    def test_game_name_lead_rejected(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        assert _phrase_lead_is_valid("halo campaign", {"halo"}) is False

    def test_two_letter_lead_rejected(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        assert _phrase_lead_is_valid("lo settings", set()) is False

    def test_empty_phrase_rejected(self):
        from services.dashboard_feedback_synthesizer import _phrase_lead_is_valid
        assert _phrase_lead_is_valid("", set()) is False


class TestLightVerbsBlockedFromLabels:
    """2026-08-06 (afternoon): user caught 'Can', 'Get', 'Come' as labels
    on SnowRunner / Halloween in the portfolio check. Modal verbs and
    light action verbs carry no semantic content but appear in most posts.
    """

    @pytest.mark.parametrize("forbidden", [
        "can", "cant", "could", "may", "might", "must",
        "get", "got", "getting", "give", "gives", "gave",
        "go", "goes", "going", "come", "came", "coming",
        "see", "seen", "know", "think", "thought",
        "take", "took", "make", "made",
        "say", "said", "tell", "told", "find", "found",
        "now", "then", "here",
    ])
    def test_light_verb_not_in_ngrams(self, forbidden):
        from services.dashboard_feedback_synthesizer import _extract_content_ngrams
        text = f"you {forbidden} the matchmaking design in this patch update"
        ngrams = _extract_content_ngrams(text)
        assert forbidden not in ngrams, (
            f"light-verb word {forbidden!r} leaked into ngrams; "
            "add it to _LIGHT_VERBS."
        )


class TestGameNameStrippedFromLabels:
    """2026-08-06 (afternoon): user caught 'Halo' / 'Hellraiser' as labels
    on their own dashboards. The game's own title token is redundant —
    the widget lives ON that game's dashboard, so labeling a cluster with
    the game name conveys zero new information.
    """

    def test_single_word_title_stripped(self):
        from services.dashboard_feedback_synthesizer import (
            _extract_content_ngrams, _game_name_tokens,
        )
        gtokens = _game_name_tokens("Halo")
        text = "Halo campaign story is emotional and jaw-dropping"
        ngrams = _extract_content_ngrams(text, gtokens)
        assert "halo" not in ngrams
        # But real content survives.
        assert "campaign" in ngrams
        assert "story" in ngrams

    def test_multi_word_title_individual_tokens_stripped(self):
        """'Silent Hill Townfall' → individual tokens (silent, hill, townfall)
        are stripped so they can't head labels. Whole-title trigram is
        still findable if someone posts the exact title."""
        from services.dashboard_feedback_synthesizer import (
            _extract_content_ngrams, _game_name_tokens,
        )
        gtokens = _game_name_tokens("SILENT HILL: Townfall")
        assert gtokens >= {"silent", "hill", "townfall"}
        text = "Silent Hill Townfall first-person immersion is amazing"
        ngrams = _extract_content_ngrams(text, gtokens)
        for tok in ("silent", "hill", "townfall"):
            assert tok not in ngrams, f"{tok!r} in {ngrams!r}"

    def test_title_stopword_the_of_and_not_added(self):
        """'The Master Chief Collection' → skip 'the' as a game-name stopword.
        (It's already a real stopword too, but we should be safe.)"""
        from services.dashboard_feedback_synthesizer import _game_name_tokens
        tokens = _game_name_tokens("Halo: The Master Chief Collection")
        assert "the" not in tokens

    def test_end_to_end_cluster_label_not_game_name(self):
        """When posts all mention the game title (as they will on a
        game-specific dashboard), the cluster label should reflect the
        specific aspect the posts are about, not the redundant title."""
        from services.dashboard_feedback_synthesizer import (
            _cluster_posts_by_shared_phrase,
        )
        posts = [
            "Halo campaign story is emotional and peak stuff",
            "The Halo campaign hit hard, especially with friends",
            "Halo campaign music is jaw-dropping in the second act",
            "Playing Halo campaign with family made me cry a lot",
            "Halo campaign remains the best storytelling in gaming",
        ]
        clusters = _cluster_posts_by_shared_phrase(
            posts, min_posts_per_cluster=3, game_name="Halo",
        )
        assert clusters
        top_label, _ = clusters[0]
        assert "halo" not in top_label.lower(), (
            f"game name in label {top_label!r}"
        )
        assert "campaign" in top_label.lower()


class TestOpinionMarkersBlockedFromLabels:
    """2026-08-06: user caught 'Like' as a label under Negative bucket for SM2.

    Opinion-marker words admit posts through the filter by construction, so
    they trivially reach the ngram-counting step with maximum frequency
    (they're in ~every survivor). They must be treated as stopwords
    BEFORE cluster labels are extracted — otherwise a Negative bucket ends
    up labelled 'Like', which reads as broken.
    """

    @pytest.mark.parametrize("forbidden", [
        "like", "liked", "liking",
        "love", "loved", "loving",
        "hate", "hated",
        "need", "needs",
        "wish", "hope",
        "had", "have", "has",
        "actually", "broken", "fix", "fixed",
        "problem", "issue", "bug",
    ])
    def test_opinion_marker_word_not_in_ngrams(self, forbidden):
        from services.dashboard_feedback_synthesizer import _extract_content_ngrams
        # A post that trivially contains the forbidden word AND a real
        # feature word. Ngram extraction must return the feature but not
        # the opinion marker.
        text = f"i {forbidden} the matchmaking design in this patch"
        ngrams = _extract_content_ngrams(text)
        assert forbidden not in ngrams, (
            f"opinion-marker word {forbidden!r} leaked into ngrams; it will "
            f"become a cluster label. Add it to _OPINION_MARKER_WORDS."
        )

    def test_negative_cluster_labelled_by_feature_not_opinion(self):
        """Given a set of negative posts about a specific mechanic, the
        cluster label must reflect the mechanic, not the opinion word."""
        from services.dashboard_feedback_synthesizer import (
            _cluster_posts_by_shared_phrase,
        )
        posts = [
            "I hate the matchmaking, keeps putting me with bots",
            "Matchmaking is broken and needs a fix",
            "Please fix the matchmaking, it's frustrating",
            "The matchmaking system in ranked is really bad",
        ]
        clusters = _cluster_posts_by_shared_phrase(posts, min_posts_per_cluster=3)
        assert clusters, "expected at least one cluster"
        top_label, _ = clusters[0]
        for banned in ("like", "hate", "broken", "fix", "needs", "bad",
                       "please", "really", "frustrating"):
            assert banned not in top_label.lower(), (
                f"opinion word {banned!r} in label {top_label!r}"
            )
        assert "matchmaking" in top_label.lower(), top_label


class TestBoilerplateStripping:
    def test_originally_posted_by_stripped(self):
        from services.dashboard_feedback_synthesizer import _strip_forum_boilerplate
        text = "Originally posted by SomePlayer: the prestige grind is too long"
        out = _strip_forum_boilerplate(text)
        assert "originally" not in out.lower()
        assert "prestige grind" in out.lower()

    def test_edit_prefix_stripped(self):
        from services.dashboard_feedback_synthesizer import _strip_forum_boilerplate
        text = "EDIT: I was wrong about the class balance being fine"
        out = _strip_forum_boilerplate(text)
        assert not out.lower().startswith("edit:")
        assert "class balance" in out.lower()

    def test_tldr_stripped(self):
        from services.dashboard_feedback_synthesizer import _strip_forum_boilerplate
        text = "TL;DR: matchmaking is broken and needs a fix"
        out = _strip_forum_boilerplate(text)
        assert "tl;dr" not in out.lower()
        assert "matchmaking" in out.lower()

    def test_quote_block_prefix_stripped(self):
        from services.dashboard_feedback_synthesizer import _strip_forum_boilerplate
        text = "> some quoted thing\nmy actual reply about the patch"
        out = _strip_forum_boilerplate(text)
        assert not out.startswith(">")

    def test_ngram_extraction_ignores_boilerplate_tokens(self):
        from services.dashboard_feedback_synthesizer import _extract_content_ngrams
        text = "Originally posted by SomeUser: matchmaking issues here"
        ngrams = _extract_content_ngrams(text)
        # No "originally", "posted", or "someuser" tokens.
        for banned in ("originally", "posted", "originally posted"):
            assert banned not in ngrams
        # Real content survives ("matchmaking" and "here"). Note that
        # 2026-08-06 added opinion markers to the stopword set so words
        # like "broken" no longer appear — that's by design (they'd
        # become useless cluster labels).
        assert "matchmaking" in ngrams


# ── Test: noise-tier posts must not enter the synthesizer corpus ──────────
#
# 2026-08-18 regression guard for the Turok: Origins hallucination. Step 5
# of services/ingestor.py has a keyword-gate fallback that can create a
# SentimentRecord for a RawPost whose v3 relevance_tier is 'noise'. If
# those rows leak into the synthesizer corpus, unrelated-game content
# ends up in the Top Topics widget for whichever game had the noise
# ingestion (Turok's r/Helldivers-polluted subreddit list produced 5,311
# such rows in a 7d window). The fix filters relevance_tier != 'noise'
# at the read side.

class TestNoiseTierExcludedFromCorpus:
    """Guard: noise-tier SentimentRecords must not feed the synthesizer."""

    def test_noise_tier_posts_are_excluded(self, db):
        """
        Create 5 SIGNAL-tier posts (should be corpus) plus 20 NOISE-tier
        posts (must be dropped even though they have SentimentRecords).
        Verify the synthesizer's cluster sees only the 5 signal posts.
        """
        from datetime import date, datetime, timedelta, timezone
        from unittest.mock import patch as _patch

        from models import (
            Game, Publisher, RawPost, SentimentEnum, SentimentRecord,
            SourceEnum,
        )
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()

        pub = Publisher(name="Test Pub Noise")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=88881, name="Noise Game",
            is_active=True, distinctive_keywords=["Noise Game"],
        )
        db.add(g); db.flush()

        # 5 legitimate signal posts, all sharing a phrase (single cluster).
        signal_bodies = [
            "The matchmaking is broken and needs a fix asap",
            "Matchmaking bugs make ranked unplayable, please patch",
            "Matchmaking has been unfair for weeks now",
            "Matchmaking issues ruin the whole experience",
            "Matchmaking system needs a serious rework",
        ]
        for i, body in enumerate(signal_bodies):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit,
                external_id=f"sig_{i}", body=body, is_relevant=True,
                relevance_tier="signal",
                post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.8, topics=[],
            ))

        # 20 NOISE-tier posts with Helldivers-style content that would
        # completely dominate the cluster if they were admitted.
        noise_bodies = [
            "Shield mech dead zone is three meters, obvious bug",
            "Flame sentry lumberer combo is broken and needs a nerf",
            "GPU stutter in first 10 minutes is unbearable",
            "Warbond content feels rushed and underbaked",
            "Stratagem cooldowns are way too long since patch",
        ] * 4  # 20 posts total
        for i, body in enumerate(noise_bodies):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit,
                external_id=f"noise_{i}", body=body, is_relevant=True,
                relevance_tier="noise",  # <-- the invariant break
                post_date=datetime.now(timezone.utc) - timedelta(hours=i + 20),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.7, topics=[],
            ))
        db.commit()

        # Sonar is stubbed — we only care about what corpus reaches it.
        captured_posts: list[list[str]] = []

        def _fake_synth(*, game_name, sentiment, cluster_phrase, cluster_posts):
            captured_posts.append(list(cluster_posts))
            return f"Fake synthesis about {cluster_phrase}."

        with _patch(
            "services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
            side_effect=_fake_synth,
        ):
            out = generate_feedback_summary(
                db=db, game_id=g.id, game_name="Noise Game",
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )

        # Cluster must see only the 5 signal posts, never the 20 noise ones.
        assert captured_posts, "expected at least one cluster to be synthesised"
        seen_texts = " || ".join("\n".join(c) for c in captured_posts)
        assert "matchmaking" in seen_texts.lower(), (
            "signal posts should be in the corpus"
        )
        # Zero noise-tier vocabulary allowed through.
        for kw in ("shield mech", "flame sentry", "lumberer", "warbond",
                   "stratagem", "gpu stutter"):
            assert kw not in seen_texts.lower(), (
                f"noise-tier vocabulary {kw!r} leaked into the synthesizer "
                f"corpus. If this fails, the relevance_tier != 'noise' filter "
                f"in generate_feedback_summary has regressed. Full corpus:\n"
                f"{seen_texts[:1500]}"
            )

        # Volume in the output should reflect only signal posts (≤5),
        # never the 20 noise ones. Some signal posts may not clear the
        # opinion+specificity clusterer bar — that's fine as long as
        # zero noise-tier posts get through.
        assert out, "expected non-empty output"
        assert 3 <= out[0].volume <= 5, (
            f"expected volume in [3, 5] (signal-only, some may not clear "
            f"opinion+specificity), got {out[0].volume}. If this is >5, the "
            f"noise filter has regressed and noise-tier rows are entering "
            f"the corpus."
        )

    def test_unclassified_and_null_tiers_still_admitted(self, db):
        """
        Rows with relevance_tier IN (NULL, 'unclassified', 'signal',
        'dedicated_sub') must ALL still count. Only explicit 'noise' is
        excluded. Legacy posts that predate the v3 tagger have
        relevance_tier=NULL and must not be silently dropped.
        """
        from datetime import date, datetime, timedelta, timezone
        from unittest.mock import patch as _patch

        from models import (
            Game, Publisher, RawPost, SentimentEnum, SentimentRecord,
            SourceEnum,
        )
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()

        pub = Publisher(name="Legacy Pub")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=88882, name="Legacy Game",
            is_active=True, distinctive_keywords=["Legacy Game"],
        )
        db.add(g); db.flush()

        # One post per tier, all sharing the same shared cluster phrase.
        tiers = [None, "unclassified", "signal", "dedicated_sub"]
        body_template = (
            "The prestige grind feels endless and needs a serious rework"
        )
        for i, tier in enumerate(tiers):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit,
                external_id=f"tier_{i}",
                body=f"{body_template} (variant {i})",
                is_relevant=True, relevance_tier=tier,
                post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.8, topics=[],
            ))
        db.commit()

        captured: list[list[str]] = []

        def _fake_synth(*, game_name, sentiment, cluster_phrase, cluster_posts):
            captured.append(list(cluster_posts))
            return "Fake."

        with _patch(
            "services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
            side_effect=_fake_synth,
        ):
            out = generate_feedback_summary(
                db=db, game_id=g.id, game_name="Legacy Game",
                sentiment=SentimentEnum.negative,
                period_key="monthly",
                period_start=date.today() - timedelta(days=30),
            )

        assert captured, "cluster should have been synthesised"
        assert len(captured[0]) == 4, (
            f"expected all 4 non-noise-tier posts in the corpus, got "
            f"{len(captured[0])}. If this is <4, the filter has become too "
            f"aggressive and is dropping unclassified/NULL/signal rows."
        )
        assert out[0].volume == 4


# v0028 (2026-09-10) — source-stratified corpus read.
#
# Adjacent-community subreddits (r/Warhammer40k, r/Helldivers, etc.)
# ingest hundreds of reddit_comment rows per day that pass the
# relevance_tier + is_off_topic_drift gates because they live under
# 'dedicated_sub' or 'signal' parent posts, but their body content is
# tabletop chat, mini-painting jokes, army-list bickering — not the
# video game. When those comments outnumber Steam-native rows 10-20:1
# for popular titles, the 2000-row cap plus the ≥3-posts-share-a-phrase
# clusterer wipes out the on-topic Steam signal and the widget renders
# 'Not enough posts with definitive signal'. Fix reads Steam-native +
# top-level-post sources first, then fills with a bounded slice of
# reddit_comment rows never exceeding _REDDIT_COMMENT_MAX_SHARE of the
# total corpus. See services/dashboard_feedback_synthesizer.py v0028
# and lessons.md 2026-09-10.

class TestRedditCommentFloodDoesNotStarveSteamNative:
    """Guard: reddit_comment volume must not crowd out Steam-native signal."""

    def test_steam_native_signal_survives_reddit_comment_flood(self, db):
        """
        Simulate the Space Marine 2 pattern: a small cluster of coherent
        Steam-forum feedback plus a large pile of reddit_comment rows
        each on a different tabletop micro-topic. Pre-v0028 the reddit
        flood would either fill the cap and starve the Steam-forum rows,
        or dilute the clusterer so the shared Steam-forum phrase never
        clears the 3-post gate. Post-v0028 the Steam-forum cluster must
        still surface.
        """
        from datetime import date, datetime, timedelta, timezone
        from unittest.mock import patch as _patch

        from models import (
            Game, Publisher, RawPost, SentimentEnum, SentimentRecord,
            SourceEnum,
        )
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()

        pub = Publisher(name="Test Pub Flood")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=88883, name="Flood Game",
            is_active=True, distinctive_keywords=["Flood Game"],
        )
        db.add(g); db.flush()

        # 5 coherent Steam-forum posts sharing a phrase (matchmaking).
        steam_bodies = [
            "The matchmaking is broken and needs a fix asap",
            "Matchmaking bugs make ranked unplayable, please patch",
            "Matchmaking has been unfair for weeks now",
            "Matchmaking issues ruin the whole experience",
            "Matchmaking system needs a serious rework",
        ]
        for i, body in enumerate(steam_bodies):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.steam_forum,
                external_id=f"sf_{i}", body=body, is_relevant=True,
                relevance_tier="signal",
                post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.8, topics=[],
            ))

        # 200 reddit_comment rows on unrelated tabletop micro-topics.
        # Each one is different enough that no cluster forms among them,
        # but they all pass relevance_tier + is_off_topic_drift because
        # they live under legitimate dedicated_sub parents.
        tabletop_bodies = [
            "The arquebus damage is not worth the wargear cost this edition",
            "Codex book shipped damaged, refund policy is terrible",
            "Radial Suffusion enhancement should be balanced against action monkey lists",
            "Warhammer plastic model prices went up again, this is bad",
            "Power scaling debates about who beats Kharn are so bad",
            "Techpriest drip is amazing but the price of the model is unfair",
            "Scout squad rules are broken, please fix in the next FAQ",
            "Yamnin Centaur APC has terrible melee weapon options",
            "Painting the aquila on shoulder pads is frustrating",
            "Army list balance is worse than last edition, refund please",
        ]
        for i in range(200):
            body = tabletop_bodies[i % len(tabletop_bodies)] + f" (msg {i})"
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit_comment,
                external_id=f"rc_{i}", body=body, is_relevant=True,
                relevance_tier="dedicated_sub",
                post_date=datetime.now(timezone.utc) - timedelta(hours=100 + i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.7, topics=[],
            ))
        db.commit()

        captured: list[list[str]] = []

        def _fake_synth(*, game_name, sentiment, cluster_phrase, cluster_posts):
            captured.append(list(cluster_posts))
            return f"Fake synthesis about {cluster_phrase}."

        with _patch(
            "services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
            side_effect=_fake_synth,
        ):
            out = generate_feedback_summary(
                db=db, game_id=g.id, game_name="Flood Game",
                sentiment=SentimentEnum.negative,
                period_key="today",
                period_start=date.today(),
            )

        # The Steam-forum matchmaking cluster must surface. If this fails,
        # the source-stratified read has regressed and reddit_comment rows
        # are again crowding out the on-topic Steam-native signal.
        assert out, (
            "expected a non-empty topic summary. If empty, the reddit_comment "
            "flood is starving the Steam-native cluster \u2014 v0028 has regressed."
        )
        assert captured, "cluster should have been synthesised"
        joined = " || ".join("\n".join(c) for c in captured)
        assert "matchmaking" in joined.lower(), (
            f"expected the Steam-forum matchmaking cluster to be surfaced. "
            f"Corpus reaching the synthesiser: {joined[:1500]}"
        )

    def test_reddit_comment_share_cap_enforced(self, db):
        """
        When priority (non-reddit_comment) rows exist, reddit_comment rows
        must not exceed _REDDIT_COMMENT_MAX_SHARE of the total read. With
        10 priority rows and MAX_SHARE=0.40, the cap on comment rows is
        floor(0.40/0.60 * 10) = 6, so a corpus of 100 available comments
        must be trimmed to 6.
        """
        from datetime import date, datetime, timedelta, timezone
        from unittest.mock import patch as _patch

        from models import (
            Game, Publisher, RawPost, SentimentEnum, SentimentRecord,
            SourceEnum,
        )
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()

        pub = Publisher(name="Test Pub Cap")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=88884, name="Cap Game",
            is_active=True, distinctive_keywords=["Cap Game"],
        )
        db.add(g); db.flush()

        # 10 priority rows (Steam forum), coherent single cluster.
        for i in range(10):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.steam_forum,
                external_id=f"sf_cap_{i}",
                body="The matchmaking is broken and needs urgent balance patch",
                is_relevant=True, relevance_tier="signal",
                post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.8, topics=[],
            ))

        # 100 reddit_comment rows available — only 6 should reach the corpus.
        # Use minutes offsets (not hours) so all 100 stay within the 'today'
        # window; a period_start=date.today() cut-off drops anything with a
        # post_date < midnight-UTC-today.
        now_utc = datetime.now(timezone.utc)
        for i in range(100):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit_comment,
                external_id=f"rc_cap_{i}",
                body=f"Arquebus damage discussion needs a nerf in patch (msg {i})",
                is_relevant=True, relevance_tier="dedicated_sub",
                post_date=now_utc - timedelta(minutes=1 + i),
                collected_at=now_utc,
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.7, topics=[],
            ))
        db.commit()

        # Instrument the base_query path by watching the survivor pool size.
        # We stub _has_opinion_and_specificity to accept everything so the
        # count of survivors == count of rows returned by the query, giving
        # us a direct measurement of the corpus read shape.
        original_filter = m._has_opinion_and_specificity
        seen_rows: list[int] = []

        def _accept_all(text):
            seen_rows.append(1)
            return True

        def _fake_synth(*, game_name, sentiment, cluster_phrase, cluster_posts):
            return "Fake."

        with _patch(
            "services.dashboard_feedback_synthesizer._has_opinion_and_specificity",
            side_effect=_accept_all,
        ), _patch(
            "services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
            side_effect=_fake_synth,
        ):
            generate_feedback_summary(
                db=db, game_id=g.id, game_name="Cap Game",
                sentiment=SentimentEnum.negative,
                period_key="today",
                period_start=date.today(),
            )

        # 10 priority + min(6 by-share, 1990 by-cap) = 16 total.
        assert len(seen_rows) == 16, (
            f"expected 10 priority + 6 comments = 16 total corpus rows, got "
            f"{len(seen_rows)}. If >16, share cap is not enforced. If <16, "
            f"priority rows are being lost."
        )

    def test_no_priority_rows_reads_no_comments(self, db):
        """
        Edge case: if the only rows for a (game, period, sentiment) tuple
        are reddit_comment rows, the share formula gives comment_budget=0
        and the corpus is empty. This is the correct behaviour — without
        any Steam-native or top-level anchor, reddit_comment content is
        exactly the pollution v0028 exists to filter. The widget will
        render the empty state, which is honest for this input shape.
        """
        from datetime import date, datetime, timedelta, timezone
        from unittest.mock import patch as _patch

        from models import (
            Game, Publisher, RawPost, SentimentEnum, SentimentRecord,
            SourceEnum,
        )
        from services import dashboard_feedback_synthesizer as m
        from services.dashboard_feedback_synthesizer import generate_feedback_summary

        m._CACHE.clear()

        pub = Publisher(name="Test Pub Only Comments")
        db.add(pub); db.flush()
        g = Game(
            publisher_id=pub.id, steam_app_id=88885, name="OnlyComments",
            is_active=True, distinctive_keywords=["OnlyComments"],
        )
        db.add(g); db.flush()

        for i in range(20):
            rp = RawPost(
                game_id=g.id, source=SourceEnum.reddit_comment,
                external_id=f"only_rc_{i}",
                body="The matchmaking is broken and needs urgent patch balance",
                is_relevant=True, relevance_tier="dedicated_sub",
                post_date=datetime.now(timezone.utc) - timedelta(hours=i),
                collected_at=datetime.now(timezone.utc),
            )
            db.add(rp); db.flush()
            db.add(SentimentRecord(
                raw_post_id=rp.id,
                sentiment=SentimentEnum.negative,
                sentiment_score=-0.7, topics=[],
            ))
        db.commit()

        called: list[bool] = []

        def _fake_synth(*, game_name, sentiment, cluster_phrase, cluster_posts):
            called.append(True)
            return "Fake."

        with _patch(
            "services.dashboard_feedback_synthesizer._synthesize_cluster_sentence",
            side_effect=_fake_synth,
        ):
            out = generate_feedback_summary(
                db=db, game_id=g.id, game_name="OnlyComments",
                sentiment=SentimentEnum.negative,
                period_key="today",
                period_start=date.today(),
            )

        assert out == [], (
            "comment-only corpus must render empty; v0028 explicitly refuses "
            "to synthesise from reddit_comment content without a Steam-native "
            "or top-level-post anchor."
        )
        assert not called, (
            "Sonar synthesiser must not be called when there is no anchor."
        )
