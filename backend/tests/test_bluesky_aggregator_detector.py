"""Tests for bluesky_service._is_aggregator_post (2026-07-28).

The detector filters release-calendar aggregators and affiliate-promo
spam that survived the exact-phrase query rewrite but still dilute
sentiment signal. These tests lock in behavior against real Bluesky
post bodies observed in production so future changes can't silently
regress or overfilter.

Every AGGREGATOR sample here was pulled from the live production feed
on 2026-07-28. Every ORGANIC sample is also real production data. If
we ever change the detector and any organic sample flips to flagged,
we've lost real fan signal and the test will catch it.
"""
from __future__ import annotations

import pytest

from services.bluesky_service import _is_aggregator_post


# ── Signal 1: Numbered list + multiple dates (release calendar) ────────────

_NUMBERED_LIST_SAMPLES = [
    # The exact "11 Marvel's Wolverine ..." template that dominated
    # Townfall Bluesky noise on 2026-07-28.
    (
        "11. ✨ Marvel's Wolverine (AAA) – Sep 15, 2026 "
        "12. ✨ Fire Emblem: Fortune's Weave (AAA) – Sep 17, 2026 "
        "13. ✨ Lego Batman: Legacy of the Dark Knight (AAA) – Sep 18, 2026 "
        "14. ✨ Control: Resonant (AAA) – Sep 24, 2026 "
        "15. ✨ SILENT HILL: Townfall (AAA) – Sep 24, 2026"
    ),
    # Longer horror-games list
    (
        "🎮 20 Upcoming Horror Games:  "
        "1. BloodRayne: Definitive Collection – Jul 29, 2026 "
        "2. Halloween: The Game – Sep 8, 2026 "
        "3. BrokenLore: DON'T LIE – Sep 10, 2026 "
        "4. Paratopic: Overdub – Sep 16, 2026 "
        "5. Room to Room – Sep 22, 2026 "
        "6. Cronos: Lazarus – Sep 30, 2026"
    ),
    # Numbered-only list continuation (no explicit month names on every line)
    (
        "7. Don't Fret – Oct 1, 2026 "
        "8. Silver Pines – Oct 8, 2026 "
        "9. Valor Mortis – Oct 13, 2026 "
        "10. Tenebris Somnia – Oct 16, 2026 "
        "11. Arizona Sunshine – 2026 "
        "12. Asylum – 2026 "
        "13. Beautiful Light – 2026"
    ),
]


@pytest.mark.parametrize("body", _NUMBERED_LIST_SAMPLES)
def test_numbered_list_calendar_flagged(body):
    is_agg, reason = _is_aggregator_post(body)
    assert is_agg, f"expected flag on numbered-list body, got False. body={body[:80]!r}"


# ── Signal 2: AAA carousel ──────────────────────────────────────────────────

def test_aaa_carousel_flagged():
    # 4 (AAA) markers → aaa_carousel signal fires
    body = (
        "🎮 4 Upcoming AAA Horror Games:  "
        "1. ✨ SILENT HILL: Townfall (AAA) – Sep 24, 2026 "
        "2. ✨ Resident Evil: Veronica (AAA) – 2027 "
        "3. ✨ Until Dawn 2 (AAA) – 2027 "
        "4. ✨ OD (AAA) – TBA"
    )
    is_agg, reason = _is_aggregator_post(body)
    assert is_agg
    # Should be caught by either the numbered_list_dates OR aaa_carousel
    # rule — either is fine.
    assert "aaa_carousel" in reason or "numbered_list_dates" in reason


# ── Signal 3: Deal / affiliate spam ─────────────────────────────────────────

_DEAL_SAMPLES = [
    # Multi-affiliate-link spam
    (
        "Clive Barker's Hellraiser: Revival (XSX) is up for pre-order on "
        "Amazon https://linktw.in/TfypSz #ad "
        "VGP https://buff.ly/hFOa8yq PNP https://buff.ly/Qxe1dlJ"
    ),
    # Brazilian price-ticker
    (
        "🎮 The Blood of Dawnwalker Steelbook Ed. PS5 = R$ 299,97 (Pix) | "
        "R$ 319,97 (até 6x) ➡️ https://link.amazon/B0b7rD9ZW"
    ),
    # GameStop bracket-price
    (
        "GameStop [$149.99]: Halloween: The Game Limited Collector's Edition "
        "- PlayStation 5  🛍 howl.me/link/?url=ht...  ⏰ 21:39:38 #ad"
    ),
    # Amazon short-link + price
    (
        "[AMAZON] Silent Hill: Townfall - PlayStation 5  Por: R$ 256,47 no Pix "
        "🎟️Use o cupom: CUPOM10  🔗 link.amazon/B042CjkMj"
    ),
]


@pytest.mark.parametrize("body", _DEAL_SAMPLES)
def test_deal_promo_flagged(body):
    is_agg, reason = _is_aggregator_post(body)
    assert is_agg, f"expected deal_promo flag, got False. body={body[:80]!r}"
    assert "deal_promo" in reason


# ── Signal 4: Hashtag-blast keyword bot ─────────────────────────────────────

def test_hashtag_stuffed_promo_bot_flagged():
    # NSFW erotica bot from real feed. Very short prose, hashtag-heavy.
    body = (
        "AN EROTICA SAGA!\n\n"
        "Omnipotence: An Erotic Saga is over 3 MILLION words. "
        "Read it for $5/month.\n\n"
        "#nsfw #erotica #3dArt #fantasy #bigboobs #lesbian #coed "
        "#bimbo #slut #halloween #college #cosplay"
    )
    is_agg, reason = _is_aggregator_post(body)
    assert is_agg
    assert "hashtag_blast" in reason


# ── ORGANIC posts — must NOT be flagged ─────────────────────────────────────

_ORGANIC_SAMPLES = [
    # Legitimate KONAMI gamescom announcement with 7 hashtags. Real news.
    (
        "KONAMI zeigt auf der gamescom 2026 neue Inhalte zu SILENT HILL: "
        "Townfall, Castlevania und weiteren Spielen. "
        "#KONAMI #gamescom2026 #SilentHill #Castlevania #YuGiOh "
        "#SaarViking #VikingGaming"
    ),
    # Fan reaction with a link and a couple hashtags
    (
        "\"We have such sights to show you\"\n\n"
        "www.tumblr.com/litsenn/8233...\n\n"
        "#durge\n#durgeoc\n#bg3durge\n#hellraiser"
    ),
    # Fan commentary — no lists, no dates, no deals
    (
        "Some still do it about 'Elevated Horror' as if Hellraiser isn't "
        "very nearly all the stuff they think is wrong with horror and also "
        "one of the best ever."
    ),
    # Movie thread
    (
        "Post a movie from the 80s that starts with the letter H  "
        "Hellraiser (1987)"
    ),
    # Personal cosplay-style hashtag post (5 tags, mostly words though)
    (
        "Personal art sneak peek, plan it to be a big art piece! "
        "Can you tell I'm in the spooky mood? 🦇 "
        "#wip #art #furry #oc #halloween"
    ),
    # Fan analysis / opinion
    (
        "Silent Hill: Townfall needs to prioritize psychological horror over "
        "action and learn from the combat-heavy mistakes that held Silent Hill "
        "f back."
    ),
    # Shopee promo — 1 deal token only, should slip through (conservative)
    (
        "[Shopee] Pré-venda de Silent Hill Townfall Day One Edition (PS5)  "
        "1️⃣ Resgate o cupom de R$30: 👉 jogobara.to/Ybnru"
    ),
    # Casual gaming comparison
    (
        "Halo 1-3>Gears 1-3 Halo 4&5>Gears 4&5 Halo 3 ODST & Reach>"
        "Gears Judgement Halo Wars<Gears Tactics"
    ),
    # Simple fan expression
    ("Oh man! I love Hellraiser!"),
    # Halloween Horror Nights (mentions multiple properties but organically)
    (
        "Halloween Horror Nights at Universal is doing a house based on "
        "Sinners. I... did not see that coming. They're also doing Evil Dead "
        "Burn, & the original Hellraiser trilogy among others."
    ),
]


@pytest.mark.parametrize("body", _ORGANIC_SAMPLES)
def test_organic_posts_not_flagged(body):
    is_agg, reason = _is_aggregator_post(body)
    assert not is_agg, (
        f"organic post falsely flagged as {reason!r}. body={body[:100]!r}"
    )


# ── Edge cases ──────────────────────────────────────────────────────────────

def test_empty_body_not_flagged():
    is_agg, reason = _is_aggregator_post("")
    assert not is_agg
    assert reason == ""


def test_none_body_safe():
    # Should not raise on None. The caller guards this but defense-in-depth.
    # Python truthiness handles None the same as "".
    is_agg, reason = _is_aggregator_post(None)  # type: ignore[arg-type]
    assert not is_agg


def test_single_short_deal_link_not_flagged():
    # A single link without additional signals must NOT be flagged.
    # Real fan posts share links all the time.
    body = "Just pre-ordered Hellraiser Revival https://buff.ly/hFOa8yq"
    is_agg, reason = _is_aggregator_post(body)
    assert not is_agg, f"single deal link should not flag, got: {reason}"


def test_ad_hashtag_without_retailer_not_flagged():
    # \"#ad\" alone (no retailer domain) shouldn't fire — the deal_promo(#ad+retailer)
    # rule requires BOTH.
    body = "Sponsored review coming this week #ad"
    is_agg, reason = _is_aggregator_post(body)
    assert not is_agg


def test_two_numbered_items_with_dates_not_flagged():
    # Threshold is 3, not 2. Fan posts sometimes list 2 games.
    body = (
        "Just picked up two games: 1. Hellraiser Revival on Sep 24, 2026. "
        "2. Turok Origins on Aug 15, 2026. Both hyped."
    )
    is_agg, reason = _is_aggregator_post(body)
    assert not is_agg, f"2-item list should not flag, got: {reason}"
