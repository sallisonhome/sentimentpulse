"""
Regression tests for services.keyword_generator.generate_default_keywords.

Guards against the 2026-07-24 ILL/Townfall data-corruption failure:
short-word titles emitting bare keywords that collided with English
usage, and franchise-spinoff titles emitting bare franchise-name
keywords that matched all franchise noise.

See lessons.md 2026-07-24 (evening).
"""
from services.keyword_generator import generate_default_keywords


class TestShortTitleGuards:
    """Short/common-word titles never emit the bare title as a keyword."""

    def test_three_letter_title_no_bare_keyword(self):
        kws = generate_default_keywords("ILL")
        # Bare "ILL" alone must NOT appear as a standalone keyword.
        assert "ILL" not in kws, f"Bare 'ILL' leaked into keywords: {kws}"
        # But qualified forms are OK.
        assert any(kw != "ILL" and "ILL" in kw for kw in kws), \
            f"No qualified ILL keyword found: {kws}"
        # At least "ILL game" must be present as the primary disambiguator.
        assert "ILL game" in kws

    def test_common_english_word_title_no_bare_keyword(self):
        # "Go" (the FromSoftware short-form game title) collides with
        # the English verb.
        kws = generate_default_keywords("Go")
        assert "Go" not in kws, f"Bare 'Go' leaked into keywords: {kws}"
        assert "Go game" in kws

    def test_fez_and_similar_no_bare_keyword(self):
        kws = generate_default_keywords("Fez")
        # Fez is 3 chars, hits the len(title) <= 3 guard.
        assert "Fez" not in kws, f"Bare 'Fez' leaked: {kws}"
        assert "Fez game" in kws

    def test_normal_title_still_gets_bare_form(self):
        # 3+ char, not-common-word titles are still emitted verbatim.
        kws = generate_default_keywords("Bus Bound")
        assert "Bus Bound" in kws
        assert "Bus Bound game" in kws


class TestFranchiseSpinoffGuards:
    """
    Franchise-spinoff titles with a colon separator never emit the bare
    main-title fragment when the main title is <3 words (would collide
    with franchise noise).
    """

    def test_two_word_franchise_no_bare_main(self):
        # "SILENT HILL" is 2 words and matches every Silent Hill
        # franchise post on r/silenthill. Must NOT be emitted.
        kws = generate_default_keywords("SILENT HILL: Townfall")
        assert "SILENT HILL" not in kws, \
            f"Bare 'SILENT HILL' leaked into Townfall keywords: {kws}"
        # But every keyword must contain "Townfall" (the disambiguator).
        assert all("Townfall" in kw or "SILENT HILL: Townfall" in kw for kw in kws), \
            f"A Townfall keyword lacks the Townfall disambiguator: {kws}"

    def test_three_word_franchise_still_emits_main(self):
        # "A Quiet Place" is 3 words \u2014 distinctive enough to keep as a
        # standalone keyword.
        kws = generate_default_keywords("A Quiet Place: The Road Ahead")
        assert "A Quiet Place" in kws, \
            f"Expected 'A Quiet Place' bare form to be preserved: {kws}"
        assert "The Road Ahead" in kws

    def test_possessive_franchise_still_emits_main(self):
        # "Clive Barker's Hellraiser" (3 words counting the possessive)
        # remains distinctive enough.
        kws = generate_default_keywords("Clive Barker's Hellraiser: Revival")
        assert "Clive Barker's Hellraiser" in kws, \
            f"Expected possessive main-title preserved: {kws}"


class TestGenericBehavior:
    def test_empty_title_returns_empty(self):
        assert generate_default_keywords("") == []
        assert generate_default_keywords("   ") == []

    def test_dedup_preserves_order(self):
        kws = generate_default_keywords("Space Marine 2")
        # First occurrence wins; no duplicates.
        assert len(kws) == len(set(k.lower() for k in kws))
        assert kws[0] == "Space Marine 2"

    def test_remaster_signal_adds_year(self):
        kws = generate_default_keywords("Turok Origins", current_year=2026)
        assert "Turok Origins 2026" in kws

    def test_trademark_glyphs_stripped(self):
        kws = generate_default_keywords("Space Marine\u2122 2")
        assert all("\u2122" not in kw for kw in kws)
        assert "Space Marine 2" in kws
