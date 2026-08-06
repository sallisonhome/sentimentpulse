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
