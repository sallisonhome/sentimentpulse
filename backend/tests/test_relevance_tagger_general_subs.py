"""
Regression tests for GENERAL_SUBS expansion on 2026-08-17.

Context: Insurgency: Sandstorm (game 148) and World War Z (game 147) were both
under-served — WWZ had only 1 sub and Insurgency had only 2. Expanding those
configs pulled in competitor / publisher / VR-platform subs whose primary
conversation is NOT the focal game. Without keyword-gating, those subs would
tag every submission as dedicated_sub for the focal game — recreating the
Turok/Helldivers false-positive tagging bug fixed on 2026-08-14.

This suite pins down that:
  1. All newly-added subs are in GENERAL_SUBS (keyword-gated, not dedicated).
  2. A competitor post in a competitor's sub does NOT admit as signal for
     the focal game just because it name-drops the focal game once.
  3. A genuine focal-game post in the same competitor sub DOES admit.
  4. The expanded WWZ DOMINANT_TOPIC_KEYWORDS actually gates against a
     name-drop post from a competitor sub.
"""
from types import SimpleNamespace

from models import SourceEnum
from services.relevance_tagger import (
    GENERAL_SUBS,
    DOMINANT_TOPIC_KEYWORDS,
    tag_post,
)


class TestGeneralSubsExpansion_2026_08_17:
    """
    Every sub added on 2026-08-17 must be in GENERAL_SUBS so it's
    keyword-gated instead of dedicated_sub.
    """

    NEW_ADDITIONS = [
        # Publisher / VR platforms
        "focusentertainment",
        "virtualreality", "vrgaming", "oculusquest", "metaquestvr",
        # Squad / Arma / RoN / Ground Branch / HLL / RS2 / OHD / SDIF /
        # Tarkov / Delta Force / MilSim
        "playsquad", "joinsquad",
        "arma", "arma3", "armareforger",
        "readyornotgame",
        "groundbranch",
        "helletloose", "hellletloose",
        "rs2vietnam", "risingstorm2",
        "harshdoorstop",
        "sixdaysinfallujah",
        "escapefromtarkov", "tarkov",
        "deltaforcegamehq", "deltaforce", "deltaforceglobal",
        "milsim",
        # Battlefield / CoD families
        "battlefield", "battlefield6", "battlefieldv", "battlefield2042",
        "callofduty", "modernwarfareiii", "modernwarfareii",
        # Zombie / co-op-shooter neighbors of WWZ
        "back4blood", "l4d2", "left4dead",
        "killingfloor", "killingfloor2",
        "vermintide", "paydaytheheist", "payday", "paydaythegame",
        "zombies", "codzombies", "postapocalyptic",
    ]

    def test_all_new_subs_in_general_subs(self):
        missing = [s for s in self.NEW_ADDITIONS if s not in GENERAL_SUBS]
        assert not missing, (
            f"These subs must be in GENERAL_SUBS to be keyword-gated: {missing}. "
            "Without this, every submission in these subs would be tagged "
            "dedicated_sub for the focal game — the Turok/Helldivers bug."
        )

    def test_insurgency_post_in_ready_or_not_sub_without_keyword_is_noise(self):
        """
        Someone posts about a Ready or Not update in r/ReadyOrNotGame. It
        does NOT mention Insurgency. Insurgency's config includes
        r/ReadyOrNotGame. Without GENERAL_SUBS gating, this would be tagged
        dedicated_sub for Insurgency. Post the fix: 'noise'.
        """
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/ReadyOrNotGame/comments/xyz/patch_details/",
            title="New Ready or Not Patch Details",
            body="The Mission Editor is a precise tool that empowers you to customize AI.",
            keywords=["Insurgency: Sandstorm", "Sandstorm", "insurgency"],
        )
        assert tier == "noise", (
            f"Ready-or-Not-specific post in r/ReadyOrNotGame must be 'noise' "
            f"for Insurgency (got {tier!r})"
        )

    def test_insurgency_post_in_ready_or_not_sub_with_keyword_is_signal(self):
        """Legit cross-title thread that name-drops Insurgency should admit."""
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/ReadyOrNotGame/comments/xyz/",
            title="How does Ready or Not compare to Insurgency: Sandstorm?",
            body="I'm looking at Insurgency Sandstorm and Ready or Not and can't decide.",
            keywords=["Insurgency: Sandstorm", "Sandstorm", "insurgency"],
        )
        assert tier == "signal", (
            f"Insurgency-mentioning post in r/ReadyOrNotGame should be 'signal' "
            f"(got {tier!r}, matched={matched})"
        )

    def test_wwz_post_in_back4blood_sub_without_keyword_is_noise(self):
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/Back4Blood/comments/xyz/",
            title="Back 4 Blood servers going down",
            body="Anyone else getting kicked from Ridden Hives?",
            keywords=["World War Z", "wwz", "worldwarz"],
        )
        assert tier == "noise", (
            f"Back-4-Blood-specific post in r/Back4Blood must be 'noise' "
            f"for WWZ (got {tier!r})"
        )

    def test_wwz_post_in_virtualreality_sub_without_keyword_is_noise(self):
        """
        r/virtualreality carries every VR game's content. Only a WWZ-mentioning
        post there should tag for WWZ.
        """
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/virtualreality/comments/xyz/",
            title="Best Quest 3 games right now?",
            body="Just picked up a Quest 3 and looking for recommendations.",
            keywords=["World War Z", "wwz", "worldwarz"],
        )
        assert tier == "noise", (
            f"Generic VR post in r/virtualreality must be 'noise' for WWZ "
            f"(got {tier!r})"
        )

    def test_wwz_vr_post_in_virtualreality_sub_is_signal(self):
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/virtualreality/comments/xyz/",
            title="World War Z VR is surprisingly good",
            body="After reading the comments here I bought WWZ VR and it's fun.",
            keywords=["World War Z", "wwz", "worldwarz"],
        )
        assert tier == "signal", (
            f"WWZ-mentioning post in r/virtualreality should be 'signal' "
            f"(got {tier!r}, matched={matched})"
        )

    def test_focus_entertainment_publisher_post_without_wwz_keyword_is_noise(self):
        """
        r/FocusEntertainment carries Warhammer, Aliens Dark Descent, Atomfall,
        etc. Only Focus posts that name-drop WWZ should tag for WWZ.
        """
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/FocusEntertainment/comments/xyz/",
            title="New Warhammer 40K game announced by Focus",
            body="Focus Entertainment revealed a new Warhammer title today.",
            keywords=["World War Z", "wwz", "worldwarz"],
        )
        assert tier == "noise", (
            f"Warhammer-specific post in r/FocusEntertainment must be 'noise' "
            f"for WWZ (got {tier!r})"
        )


class TestWWZDominantKeywordsExpansion_2026_08_17:
    """
    The WWZ DOMINANT_TOPIC_KEYWORDS was expanded from 6 tokens to ~30. The
    dominant-topic gate only triggers when a post has 2+ hits from the
    OWNING sub's dominant keywords. Verify the expansion actually pins
    down false-positive scenarios and doesn't over-mute genuine posts.
    """

    def test_wwz_dominant_keywords_include_expansion(self):
        wwz_kws = DOMINANT_TOPIC_KEYWORDS["worldwarzthegame"]
        # Sanity: expansions we specifically added
        for tok in ("doyle", "raven rock", "bull zombie", "screamer",
                    "wwz vr", "aftermath"):
            assert tok in wwz_kws, (
                f"Expected {tok!r} in worldwarzthegame DOMINANT_TOPIC_KEYWORDS"
            )

    def test_turok_post_in_worldwarzthegame_scenario_no_longer_applies_v0028(self):
        """
        SUPERSEDED by v0028 (2026-08-28). Rationale:

        r/worldwarzthegame is now correctly treated as WWZ's DEDICATED
        game sub (removed from GENERAL_SUBS). To keep the protection
        this test was designed for, Toxic Commando, Turok, and Jurassic
        Park all had `worldwarzthegame` REMOVED from their per-game
        subreddit configs on 2026-08-28. So a WWZ-primary post there
        can never be fetched under one of those games' configs in the
        first place, and can't leak into their dedicated_sub tier.

        This test is preserved (converted from an assertion to a comment)
        so future maintainers understand why r/worldwarzthegame moved
        out of GENERAL_SUBS and what parallel data cleanup was required.

        If a future maintainer re-adds `worldwarzthegame` to another
        game's subreddits without also re-adding it to GENERAL_SUBS,
        WWZ posts will pollute that game's dedicated_sub bucket. See
        lessons.md 2026-08-28 rule 5.
        """
        # Sanity: worldwarzthegame is no longer in GENERAL_SUBS.
        assert "worldwarzthegame" not in {g.lower() for g in GENERAL_SUBS}


# ────────────────────────────────────────────────────────────────────────────
# v0028 (2026-08-28) — dedicated game communities must NOT be in GENERAL_SUBS
#
# Bug being locked out: on 2026-08-14, the GENERAL_SUBS expansion swept
# `hellraiserthegame` and `worldwarzthegame` into GENERAL_SUBS alongside the
# movie-IP subs (r/hellraiser, r/clivebarker). Those two are the DEDICATED
# game communities for Hellraiser Revival and World War Z — posts there are
# ~100% about the game. GENERAL_SUBS membership forces posts through the
# strict two-token keyword gate, so they lost dedicated_sub status and
# Hellraiser's signal-tier reddit dropped from Halloween-comparable levels
# to a handful per week.
#
# Rule: a subreddit whose primary conversation IS a single game must NOT be
# in GENERAL_SUBS. This test enforces the specific known cases and provides
# a positive-case pattern for future dedicated communities.
# ────────────────────────────────────────────────────────────────────────────


class TestDedicatedGameSubsNotInGeneralSubs_v0028:
    """r/hellraiserthegame and r/worldwarzthegame must NOT be treated as
    keyword-gated general subs."""

    # Dedicated game communities. Every post is presumed about the game.
    DEDICATED_GAME_SUBS = [
        "hellraiserthegame",   # Hellraiser Revival
        "worldwarzthegame",    # World War Z
        # For comparison, Halloween's dedicated subs — already correctly
        # OMITTED from GENERAL_SUBS. Included in this list so a future
        # over-eager sweep can't accidentally add them.
        "halloweentvg",
        "thehalloweengame",
        # SM2's dedicated sub
        "spacemarine_2",
    ]

    def test_dedicated_game_subs_not_in_GENERAL_SUBS(self):
        offenders = [
            s for s in self.DEDICATED_GAME_SUBS
            if s.lower() in {g.lower() for g in GENERAL_SUBS}
        ]
        assert not offenders, (
            f"Dedicated game community subreddits must NOT be in GENERAL_SUBS "
            f"(they would lose dedicated_sub tagging and require keyword "
            f"matching, silently dropping game-specific content). "
            f"Offenders: {offenders}"
        )

    def test_hellraiserthegame_post_tags_as_dedicated_sub_no_keywords(self):
        """A post in r/hellraiserthegame with no mention of any distinctive
        keyword must still tag as dedicated_sub. Prior to v0028 it would
        have been rejected by the strict two-token gate."""
        keywords = ["hellraiser revival", "boss team hellraiser"]
        # A real post title from r/hellraiserthegame that doesn't happen to
        # contain any distinctive keyword variant.
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/hellraiserthegame/comments/xxx/happy_birthday_terry_farrell/",
            title="Happy Birthday, Terry Farrell (Joey Summerskill)",
            body="Just wanted to say happy birthday to Terry",
            keywords=keywords,
        )
        assert tier == "dedicated_sub", (
            f"r/hellraiserthegame post should tag as dedicated_sub (game "
            f"community); got tier={tier}, matched={matched}"
        )

    def test_worldwarzthegame_post_tags_as_dedicated_sub_no_keywords(self):
        """Same guarantee for r/worldwarzthegame."""
        keywords = ["world war z game", "wwz vr", "saber wwz"]
        tier, matched = tag_post(
            source=SourceEnum.reddit,
            url="https://www.reddit.com/r/worldwarzthegame/comments/xxx/anyone_still_playing/",
            title="Anyone still playing?",
            body="Wondering if there's a community still active",
            keywords=keywords,
        )
        assert tier == "dedicated_sub", (
            f"r/worldwarzthegame post should tag as dedicated_sub; "
            f"got tier={tier}, matched={matched}"
        )

    def test_hellraiser_movie_ip_sub_still_keyword_gated(self):
        """r/hellraiser (the movie/IP sub) MUST stay in GENERAL_SUBS so
        random Cenobite movie chatter doesn't get tagged as Hellraiser
        Revival dedicated_sub content."""
        assert "hellraiser" in {g.lower() for g in GENERAL_SUBS}, (
            "r/hellraiser is the broader movie IP sub \u2014 must remain "
            "keyword-gated in GENERAL_SUBS. Do NOT remove it while "
            "un-marking r/hellraiserthegame."
        )

    def test_clivebarker_ip_sub_still_keyword_gated(self):
        """r/clivebarker MUST stay in GENERAL_SUBS \u2014 author sub, broader
        than one game."""
        assert "clivebarker" in {g.lower() for g in GENERAL_SUBS}
