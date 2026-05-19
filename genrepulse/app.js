// Genre Pulse — mirrors howmanyareplaying.com Genre Performance Tables
// API is proxied through Nginx at /genrepulse/api/* to bypass CORS.

const API_BASE = '/genrepulse/api';
const main = document.getElementById('main');
const genreSidebarSection = document.getElementById('genre-list-section');
const genreSidebarList = document.getElementById('genre-sidebar-list');

// ── Platform Mix module ────────────────────────────────────────────────────
// Mirrors howmanyareplaying.com's PlatformMixPopover (Layout 3, Variant C badge).
// All Saber-specific code is namespaced under PM_*; markup uses .pm-* classes.
// ISOLATION: this widget is read-only against row data. It NEVER writes back
// into game cells, sort keys, averages, or any export. The +/+ Platforms
// column simply hosts a personal overlay that lives in a per-session row
// (user_platform_mix table on the upstream backend, identified by connect.sid).
const PM_PLATFORM_KEYS = ['steam', 'pc_other', 'xbox', 'playstation', 'switch'];
// The four user-editable platforms. Steam is anchored: its % is always derived
// as (100 - sum of these four) and is read-only in the UI.
const PM_OTHER_KEYS = ['pc_other', 'xbox', 'playstation', 'switch'];
const PM_PLATFORM_META = {
  steam:       { label: 'Steam',         color: '#66c0f4' },
  pc_other:    { label: 'PC Other',      color: '#d0d0e0' },
  xbox:        { label: 'Xbox',          color: '#5cd45c' },
  playstation: { label: 'PlayStation',   color: '#6aa9e9' },
  switch:      { label: 'Switch / 2',    color: '#ff7a85' },
};
const PM_DEFAULT_MIX = {
  steam_pct: 100, pc_other_pct: 0, xbox_pct: 0, playstation_pct: 0, switch_pct: 0,
};

// ── Commit-on-submit helpers (mirrors frontend/src/platform-mix/rebalance.js)
// Coerce a raw input value (string/number/NaN) to an integer in [0, 100].
function pmCoercePct(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n)) n = 0;
  n = Math.round(n);
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return n;
}

// Validate the four non-Steam inputs. Returns { ok, error, othersSum, steamPct }.
function pmValidateOthers(others) {
  const vals = PM_OTHER_KEYS.map((k) => pmCoercePct(others[`${k}_pct`]));
  const othersSum = vals.reduce((s, v) => s + v, 0);
  if (othersSum > 100) {
    return { ok: false, error: "Totals can't exceed 100%.", othersSum, steamPct: null };
  }
  if (othersSum === 100) {
    return { ok: false, error: "Steam can't be 0% — it's the anchor.", othersSum, steamPct: 0 };
  }
  return { ok: true, error: null, othersSum, steamPct: 100 - othersSum };
}

// Build the canonical mix object the backend expects from the user's edits.
// Throws if validation fails. Always produces integers summing to exactly 100.
function pmCommitFromOthers(others) {
  const v = pmValidateOthers(others);
  if (!v.ok) {
    const err = new Error(v.error);
    err.code = 'INVALID_MIX';
    throw err;
  }
  const out = { steam_pct: v.steamPct };
  for (const k of PM_OTHER_KEYS) {
    out[`${k}_pct`] = pmCoercePct(others[`${k}_pct`]);
  }
  return out;
}

// Extract just the four editable fields from a full mix object.
function pmOthersFromMix(mix) {
  const out = {};
  for (const k of PM_OTHER_KEYS) {
    out[`${k}_pct`] = pmCoercePct(mix && mix[`${k}_pct`]);
  }
  return out;
}

function pmIsDefaultMix(mix) {
  return PM_PLATFORM_KEYS.every(k => mix[`${k}_pct`] === PM_DEFAULT_MIX[`${k}_pct`]);
}

function pmActiveCount(mix) {
  return PM_PLATFORM_KEYS.reduce((n, k) => n + (mix[`${k}_pct`] > 0 ? 1 : 0), 0);
}

// Pure rebalance — ported verbatim from frontend/src/platform-mix/rebalance.js.
// Any pct change re-distributes proportionally across the other four so the
// total is always exactly 100 (backend CHECK constraint).
function pmRebalance(mix, changedKey, rawValue) {
  if (!PM_PLATFORM_KEYS.includes(changedKey)) {
    throw new Error(`pmRebalance: unknown key ${changedKey}`);
  }
  let newVal = Number(rawValue);
  if (!Number.isFinite(newVal)) newVal = 0;
  newVal = Math.max(0, Math.min(100, Math.round(newVal)));
  const next = { ...mix };
  const others = PM_PLATFORM_KEYS.filter(k => k !== changedKey);
  const newOthersSum = 100 - newVal;
  const oldOthersSum = others.reduce((s, k) => s + (next[`${k}_pct`] || 0), 0);
  next[`${changedKey}_pct`] = newVal;
  if (oldOthersSum === 0) {
    const each = Math.floor(newOthersSum / others.length);
    others.forEach(k => { next[`${k}_pct`] = each; });
    const remainder = newOthersSum - each * others.length;
    if (remainder !== 0) next[`${others[0]}_pct`] += remainder;
  } else {
    let running = 0;
    others.forEach((k, i) => {
      if (i === others.length - 1) {
        next[`${k}_pct`] = newOthersSum - running;
      } else {
        const v = Math.round(next[`${k}_pct`] * (newOthersSum / oldOthersSum));
        next[`${k}_pct`] = v;
        running += v;
      }
    });
  }
  others.forEach(k => {
    if (next[`${k}_pct`] < 0) next[`${k}_pct`] = 0;
    if (next[`${k}_pct`] > 100) next[`${k}_pct`] = 100;
  });
  let total = PM_PLATFORM_KEYS.reduce((s, k) => s + next[`${k}_pct`], 0);
  let safety = 200;
  while (total !== 100 && safety-- > 0) {
    const target = others.find(k => total < 100 ? next[`${k}_pct`] < 100 : next[`${k}_pct`] > 0);
    if (!target) break;
    next[`${target}_pct`] += total < 100 ? 1 : -1;
    total = PM_PLATFORM_KEYS.reduce((s, k) => s + next[`${k}_pct`], 0);
  }
  return next;
}

// API — hits /genrepulse/api/platform-mix/:appid through the Saber nginx proxy.
// `credentials: 'include'` makes the browser send/store the connect.sid cookie
// that express-session uses to identify the user.
async function pmFetchMix(appid) {
  const res = await fetch(`${API_BASE}/platform-mix/${appid}`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Mix GET ${appid} returned ${res.status}`);
  return res.json();
}

async function pmSaveMix(appid, mix) {
  const res = await fetch(`${API_BASE}/platform-mix/${appid}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      steam_pct: mix.steam_pct,
      pc_other_pct: mix.pc_other_pct,
      xbox_pct: mix.xbox_pct,
      playstation_pct: mix.playstation_pct,
      switch_pct: mix.switch_pct,
    }),
  });
  if (!res.ok) {
    let err = `Mix PUT ${appid} returned ${res.status}`;
    try { const body = await res.json(); if (body.error) err = body.error; } catch {}
    throw new Error(err);
  }
  return res.json();
}

// Formatters local to the popover (matches the React version's output)
function pmFmtUsd(cents) {
  if (!Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1_000)     return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}
function pmFmtUnits(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

// Per-row state. Keyed by appid; created lazily when a badge is first clicked.
// Holds: { mix, isCustom, activeCount } so the badge can re-render its style
// after a save without re-fetching.
const pmRowState = new Map();

// Popover singleton — only one open at a time.
let pmActivePopover = null;
let pmActiveAppid = null;
let pmActiveAnchorEl = null;
let pmSaveTimer = null;
let pmReposListenersAttached = false;
let pmScrollHandler = null;
let pmResizeHandler = null;

function pmClosePopover() {
  if (!pmActivePopover) return;
  pmActivePopover.remove();
  pmActivePopover = null;
  pmActiveAppid = null;
  pmActiveAnchorEl = null;
  if (pmSaveTimer) { clearTimeout(pmSaveTimer); pmSaveTimer = null; }
  if (pmReposListenersAttached) {
    window.removeEventListener('scroll', pmScrollHandler, true);
    window.removeEventListener('resize', pmResizeHandler);
    document.removeEventListener('mousedown', pmOutsideHandler, true);
    document.removeEventListener('keydown', pmKeyHandler, true);
    pmReposListenersAttached = false;
  }
}

function pmRepositionPopover() {
  if (!pmActivePopover || !pmActiveAnchorEl) return;
  const rect = pmActiveAnchorEl.getBoundingClientRect();
  const POPOVER_W = 340;
  let left = rect.right - POPOVER_W;
  if (left < 8) left = 8;
  const maxLeft = window.innerWidth - POPOVER_W - 8;
  if (left > maxLeft) left = maxLeft;
  pmActivePopover.style.left = `${left}px`;
  pmActivePopover.style.top = `${rect.bottom + 6}px`;
}

function pmOutsideHandler(e) {
  if (!pmActivePopover) return;
  if (pmActivePopover.contains(e.target)) return;
  // Don't close on badge click — the badge has its own toggle handler
  if (pmActiveAnchorEl && pmActiveAnchorEl.contains(e.target)) return;
  pmClosePopover();
}

function pmKeyHandler(e) {
  if (e.key === 'Escape') pmClosePopover();
}

function pmRenderBadge(g) {
  if (g.is_prerelease) return '<span class="muted-dash">—</span>';
  if (!Number.isFinite(g.estimated_owners) || g.estimated_owners <= 0) {
    // No anchor units — the totals math won't work. Hide the badge entirely.
    return '<span class="muted-dash">—</span>';
  }
  const state = pmRowState.get(g.appid);
  const isCustom = !!(state && state.isCustom);
  const activeCount = state ? state.activeCount : 1;
  const cls = `pm-badge${isCustom ? ' pm-badge--custom' : ''}`;
  const label = isCustom ? `Mix · ${activeCount}` : '+ Platforms';
  // data-appid is the only thing the click handler needs; the game's anchor
  // values (units_steam, asp_cents) are looked up from currentGenreData by appid.
  return `<button type="button" class="${cls}" data-pm-appid="${g.appid}" aria-label="Open platform mix">${label}</button>`;
}

// Commit-on-submit popover (mirrors React PlatformMixPopover.jsx 2026-05-18).
// Steam is read-only — its % is derived as (100 - sum of other four). The user
// edits the four non-Steam platforms freely; nothing saves until they click
// "Commit values". Invalid sums (>100, or ==100 which would zero Steam) surface
// an inline error and the Commit button is disabled.
function pmRenderPopover(appid) {
  // anchor row data (units_steam, asp_cents) comes from currentGenreData.
  // Port of howmanyareplaying.com's o1() ASP formula — verbatim:
  //   is_free ? null
  //   : lifetime_avg_price_cents ?? Math.round(msrp_usd_cents * 0.66)
  const game = currentGenreData?.games?.find(g => g.appid === appid);
  if (!game) return;
  const unitsSteam = game.estimated_owners;
  const aspCents = game.is_free
    ? null
    : (game.lifetime_avg_price_cents != null
        ? game.lifetime_avg_price_cents
        : (game.msrp_usd_cents
            ? Math.round(game.msrp_usd_cents * 0.66)
            : null));

  const existing = pmRowState.get(appid);
  // `committed` = last successfully-saved mix (drives badge, dirty check, bar
  // fallback when invalid). `draftOthers` = the four editable fields the user
  // is currently typing. Steam is NEVER in draftOthers — it's derived.
  let committed = existing ? { ...existing.mix } : { ...PM_DEFAULT_MIX };
  let draftOthers = pmOthersFromMix(committed);
  let loaded = !!existing;
  let saveState = 'idle'; // 'idle' | 'saving' | 'saved' | 'error'
  let saveError = '';

  // Build DOM
  const pop = document.createElement('div');
  pop.className = 'pm-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Platform mix overlay');
  pop.style.position = 'fixed';
  pop.style.width = '340px';
  document.body.appendChild(pop);
  pmActivePopover = pop;
  pmActiveAppid = appid;

  // Track which input was focused before a re-render so we can restore focus
  // and caret position after innerHTML rewrite.
  let lastFocusedKey = null;
  let lastSelStart = null;
  let lastSelEnd = null;

  function captureFocus() {
    const active = pop.contains(document.activeElement) ? document.activeElement : null;
    if (active && active.matches?.('input.pm-cell__input')) {
      lastFocusedKey = active.dataset.pmKey || null;
      lastSelStart = active.selectionStart;
      lastSelEnd = active.selectionEnd;
    } else {
      lastFocusedKey = null;
    }
  }

  function restoreFocus() {
    if (!lastFocusedKey) return;
    const el = pop.querySelector(`input.pm-cell__input[data-pm-key="${lastFocusedKey}"]`);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(lastSelStart, lastSelEnd); } catch (_) {}
  }

  function paint() {
    captureFocus();

    const validation = pmValidateOthers(draftOthers);
    // Preview mix used for totals + bar when valid. When invalid we fall back
    // to the last committed mix for the bar so it doesn't go blank mid-edit.
    const previewMix = validation.ok
      ? {
          steam_pct: validation.steamPct,
          pc_other_pct:    pmCoercePct(draftOthers.pc_other_pct),
          xbox_pct:        pmCoercePct(draftOthers.xbox_pct),
          playstation_pct: pmCoercePct(draftOthers.playstation_pct),
          switch_pct:      pmCoercePct(draftOthers.switch_pct),
        }
      : null;
    const barMix = previewMix || committed;

    const totals = (function() {
      if (!previewMix) return null;
      const sp = previewMix.steam_pct;
      if (!Number.isFinite(unitsSteam) || unitsSteam <= 0 || sp <= 0) return null;
      const totalUnits = (unitsSteam / sp) * 100;
      const perPlatform = PM_PLATFORM_KEYS.map(k => {
        const pct = previewMix[`${k}_pct`];
        const u = totalUnits * pct / 100;
        const gross = Number.isFinite(aspCents) ? u * aspCents : null;
        return { key: k, pct, units: u, grossCents: gross };
      });
      const totalGrossCents = Number.isFinite(aspCents) ? totalUnits * aspCents : null;
      return { perPlatform, totalUnits, totalGrossCents };
    })();

    // Has the user edited the draft since the last commit?
    let dirty = false;
    if (loaded) {
      for (const k of PM_OTHER_KEYS) {
        if (pmCoercePct(draftOthers[`${k}_pct`]) !== pmCoercePct(committed[`${k}_pct`])) {
          dirty = true; break;
        }
      }
    }
    const draftIsDefault = PM_OTHER_KEYS.every(k => pmCoercePct(draftOthers[`${k}_pct`]) === 0);
    const canCommit = loaded && dirty && validation.ok && saveState !== 'saving';

    // Live Steam % — even when invalid we show 100 - othersSum so the user can
    // see why we're blocking commit. May be negative when othersSum > 100.
    const liveSteamPct = 100 - validation.othersSum;

    pop.innerHTML = `
      <div class="pm-popover__header">
        <span class="pm-popover__title">Cross-platform mix</span>
        <button type="button" class="pm-popover__close" aria-label="Close">✕</button>
      </div>

      <div class="pm-bar" aria-hidden="true">
        ${PM_PLATFORM_KEYS.map(k => {
          const pct = barMix[`${k}_pct`];
          if (pct <= 0) return '';
          return `<div class="pm-bar__seg" style="flex:${pct};background:${PM_PLATFORM_META[k].color}" title="${PM_PLATFORM_META[k].label}: ${pct}%">${pct >= 10 ? `<span class="pm-bar__lbl">${pct}%</span>` : ''}</div>`;
        }).join('')}
      </div>

      <div class="pm-grid">
        <div class="pm-cell pm-cell--anchor pm-cell--readonly">
          <span class="pm-cell__lbl">
            <span class="pm-swatch" style="background:${PM_PLATFORM_META.steam.color}" aria-hidden="true"></span>
            ${PM_PLATFORM_META.steam.label}
            <span class="pm-cell__anchor-tag">anchor</span>
          </span>
          <span class="pm-cell__input-wrap">
            <span class="pm-cell__readonly-value" aria-label="Steam percent (auto, ${liveSteamPct}%)">${liveSteamPct}</span>
            <span class="pm-cell__suffix">%</span>
          </span>
        </div>
        ${PM_OTHER_KEYS.map(k => `
          <label class="pm-cell">
            <span class="pm-cell__lbl">
              <span class="pm-swatch" style="background:${PM_PLATFORM_META[k].color}" aria-hidden="true"></span>
              ${PM_PLATFORM_META[k].label}
            </span>
            <span class="pm-cell__input-wrap">
              <input type="number" min="0" max="100" step="1" inputmode="numeric"
                     class="pm-cell__input" data-pm-key="${k}"
                     value="${escapeAttr(String(draftOthers[`${k}_pct`] ?? 0))}" aria-label="${PM_PLATFORM_META[k].label} percent">
              <span class="pm-cell__suffix">%</span>
            </span>
          </label>
        `).join('')}
      </div>

      ${!validation.ok ? `
        <div class="pm-error" role="alert">
          ${escapeHtml(validation.error)}
          <span class="pm-error__sub">Other platforms total ${validation.othersSum}%.</span>
        </div>
      ` : ''}

      <div class="pm-totals">
        ${totals ? (`
          <div class="pm-totals__caption">Preview (uncommitted)</div>
          ${totals.perPlatform.filter(r => r.pct > 0).map(row => `
            <div class="pm-totals__row">
              <span class="pm-totals__name">
                <span class="pm-swatch" style="background:${PM_PLATFORM_META[row.key].color}" aria-hidden="true"></span>
                ${PM_PLATFORM_META[row.key].label}
              </span>
              <span class="pm-totals__num">${pmFmtUnits(row.units)} units · ${pmFmtUsd(row.grossCents)}</span>
            </div>
          `).join('')}
          <div class="pm-totals__row pm-totals__row--grand">
            <span class="pm-totals__name">All platforms</span>
            <span class="pm-totals__num">${pmFmtUnits(totals.totalUnits)} units · ${pmFmtUsd(totals.totalGrossCents)}</span>
          </div>
        `) : (validation.ok ? '<div class="pm-totals__hint">Set Steam &gt; 0 to anchor totals.</div>' : '')}
      </div>

      <div class="pm-footer">
        <button type="button" class="pm-footer__reset" ${draftIsDefault ? 'disabled' : ''}>Reset to Steam only</button>
        <button type="button" class="pm-footer__commit" ${canCommit ? '' : 'disabled'}>${
          saveState === 'saving' ? 'Committing…' : 'Commit values'
        }</button>
      </div>

      <div class="pm-status pm-status--${saveState}">${
        saveState === 'saved'  ? '✓ Committed' :
        saveState === 'error'  ? `Error: ${escapeHtml(saveError)}` :
        !validation.ok         ? '' :
        dirty                  ? 'Edits pending — click Commit values to save.' : ''
      }</div>

      <div class="pm-note">Personal view. Doesn't affect Compare, genre rankings, or exports.</div>
    `;

    // Wire input handlers — local state only, NO autosave on keystroke.
    pop.querySelectorAll('input.pm-cell__input').forEach(input => {
      input.addEventListener('input', e => {
        const key = e.target.dataset.pmKey;
        if (!PM_OTHER_KEYS.includes(key)) return;
        // Keep the raw string while typing so the field doesn't fight the user
        // (e.g. clearing the box to retype). We coerce when validating/committing.
        draftOthers = { ...draftOthers, [`${key}_pct`]: e.target.value };
        // Clear any stale server-side save error the moment the user edits again.
        if (saveState === 'error') {
          saveState = 'idle';
          saveError = '';
        }
        paint();
      });
    });
    pop.querySelector('.pm-popover__close')?.addEventListener('click', pmClosePopover);
    pop.querySelector('.pm-footer__reset')?.addEventListener('click', () => {
      draftOthers = pmOthersFromMix(PM_DEFAULT_MIX);
      saveState = 'idle';
      saveError = '';
      paint();
    });
    pop.querySelector('.pm-footer__commit')?.addEventListener('click', commit);

    pmRepositionPopover();
    pmRefreshBadge(appid);
    restoreFocus();
  }

  async function commit() {
    const validation = pmValidateOthers(draftOthers);
    if (!validation.ok) return;
    let payload;
    try {
      payload = pmCommitFromOthers(draftOthers);
    } catch (err) {
      saveState = 'error';
      saveError = err.message || 'Invalid mix';
      paint();
      return;
    }
    saveState = 'saving';
    saveError = '';
    paint();
    try {
      await pmSaveMix(appid, payload);
      committed = payload;
      draftOthers = pmOthersFromMix(payload);
      saveState = 'saved';
      pmRowState.set(appid, {
        mix: payload,
        isCustom: !pmIsDefaultMix(payload),
        activeCount: pmActiveCount(payload),
      });
      paint();
      setTimeout(() => {
        if (saveState === 'saved') { saveState = 'idle'; paint(); }
      }, 1400);
    } catch (err) {
      saveState = 'error';
      saveError = err.message || 'Save failed';
      paint();
    }
  }

  // Initial paint (default mix or cached) so the popover appears instantly.
  paint();

  // Attach reposition + dismiss listeners
  pmScrollHandler = () => pmRepositionPopover();
  pmResizeHandler = () => pmRepositionPopover();
  window.addEventListener('scroll', pmScrollHandler, true);
  window.addEventListener('resize', pmResizeHandler);
  document.addEventListener('mousedown', pmOutsideHandler, true);
  document.addEventListener('keydown', pmKeyHandler, true);
  pmReposListenersAttached = true;

  // Fetch saved mix (replaces the default if the user had something stored).
  // Only mutates draftOthers if the user hasn't started editing yet — we don't
  // want a slow GET to clobber in-progress edits.
  if (!existing) {
    pmFetchMix(appid).then(res => {
      if (pmActiveAppid !== appid) return; // popover closed before fetch landed
      committed = { ...res.mix };
      // Only overwrite the draft if it's still pristine (matches the previous
      // committed state, which started as DEFAULT_MIX).
      const stillPristine = PM_OTHER_KEYS.every(k =>
        pmCoercePct(draftOthers[`${k}_pct`]) === PM_DEFAULT_MIX[`${k}_pct`]
      );
      if (stillPristine) {
        draftOthers = pmOthersFromMix(committed);
      }
      loaded = true;
      pmRowState.set(appid, {
        mix: committed,
        isCustom: !res.isDefault,
        activeCount: pmActiveCount(committed),
      });
      paint();
    }).catch(() => {
      loaded = true; // allow commits anyway; subsequent PUT will create the row
      paint();
    });
  } else {
    loaded = true;
  }
}

function pmRefreshBadge(appid) {
  const tdList = document.querySelectorAll(`td button.pm-badge[data-pm-appid="${appid}"]`);
  if (!tdList.length) return;
  const state = pmRowState.get(appid);
  const isCustom = !!(state && state.isCustom);
  const activeCount = state ? state.activeCount : 1;
  tdList.forEach(btn => {
    btn.className = `pm-badge${isCustom ? ' pm-badge--custom' : ''}`;
    btn.textContent = isCustom ? `Mix · ${activeCount}` : '+ Platforms';
  });
}

function pmHandleBadgeClick(e) {
  const btn = e.target.closest('button.pm-badge[data-pm-appid]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const appid = Number(btn.dataset.pmAppid);
  if (pmActiveAppid === appid) {
    // Same badge clicked — toggle closed
    pmClosePopover();
    return;
  }
  // Different badge (or none open) — close existing, open new
  pmClosePopover();
  pmActiveAnchorEl = btn;
  pmRenderPopover(appid);
}


// ── Cache ──────────────────────────────────────────────────────────────────
let genreListCache = null;
const genreDetailCache = new Map();

// ── Formatters ─────────────────────────────────────────────────────────────
const fmt = {
  money(cents) {
    if (cents == null) return '—';
    const dollars = cents / 100;
    if (dollars >= 1_000_000_000) return `$${(dollars / 1_000_000_000).toFixed(1)}B`;
    if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
    if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
    return `$${dollars.toFixed(2)}`;
  },
  price(cents) {
    if (cents == null) return '—';
    return `$${(cents / 100).toFixed(2)}`;
  },
  num(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return Math.round(n).toLocaleString();
  },
  numFull(n) {
    if (n == null) return '—';
    return Math.round(n).toLocaleString();
  },
  hours(h) {
    if (h == null) return '—';
    return `${h.toFixed(1)}h`;
  },
  pct(p) {
    if (p == null) return '—';
    return `${p.toFixed(1)}%`;
  },
  date(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  },
  relTime(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    const now = new Date();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  },
};

// ── Pos % color tier ───────────────────────────────────────────────────────
function posPctClass(p) {
  if (p == null) return '';
  if (p >= 80) return 'high';
  if (p >= 60) return 'mid';
  return 'low';
}

// ── API ────────────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

async function loadGenres() {
  if (genreListCache) return genreListCache;
  genreListCache = await api('/genres');
  return genreListCache;
}

async function loadGenre(slug) {
  if (genreDetailCache.has(slug)) return genreDetailCache.get(slug);
  const data = await api(`/genres/${encodeURIComponent(slug)}`);
  genreDetailCache.set(slug, data);
  return data;
}

// ── Sidebar genre list ─────────────────────────────────────────────────────
function renderSidebarGenres(genres, activeSlug) {
  if (!genres.length) { genreSidebarSection.style.display = 'none'; return; }
  genreSidebarSection.style.display = '';
  genreSidebarList.innerHTML = genres.map(g => `
    <a href="#/genres/${g.slug}" class="sidebar-link${activeSlug === g.slug ? ' active' : ''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
      </svg>
      ${escapeHtml(g.name)}
    </a>
  `).join('');
}

// ── Pages ──────────────────────────────────────────────────────────────────
async function renderIndex() {
  main.innerHTML = `
    <div class="page-header">
      <div class="page-eyebrow">Genre Pulse</div>
      <h1 class="page-title">Genre Performance Tables</h1>
      <p class="page-subtitle">Bi-weekly Steam analytics by genre — pricing, playtime, CCU, reviews, and estimated sales. Mirrored from <a href="https://www.howmanyareplaying.com/genres" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline">howmanyareplaying.com</a>.</p>
    </div>

    <div class="genre-grid" id="genre-grid">
      ${Array.from({ length: 6 }).map(() => `<div class="skeleton skeleton-card"></div>`).join('')}
    </div>
  `;

  try {
    const genres = await loadGenres();
    renderSidebarGenres(genres, null);
    const grid = document.getElementById('genre-grid');
    if (!genres.length) {
      grid.innerHTML = `<div class="empty-state">No genres available yet.</div>`;
      return;
    }
    grid.innerHTML = genres.map(g => `
      <a href="#/genres/${g.slug}" class="genre-card">
        <div class="genre-card-title">Top ${escapeHtml(g.name)} Games</div>
        <div class="genre-card-meta">${g.game_count} game${g.game_count === 1 ? '' : 's'}</div>
        <div class="genre-card-footer">
          <span>Updated ${fmt.relTime(g.last_refresh)}</span>
          <span class="genre-card-cta">View →</span>
        </div>
      </a>
    `).join('');
  } catch (err) {
    main.querySelector('#genre-grid').innerHTML = `
      <div class="error-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div>Failed to load genres: ${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

// ── Genre detail page ──────────────────────────────────────────────────────
let currentGenreData = null;
let currentSort = { key: 'estimated_gross_sales_usd_cents', dir: 'desc' };

async function renderGenreDetail(slug) {
  main.innerHTML = `
    <a href="#/" class="back-link">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
      All Genre Performance Tables
    </a>
    <div class="page-header">
      <div class="page-eyebrow">Genre Pulse</div>
      <h1 class="page-title" id="genre-title">Loading…</h1>
      <p class="page-subtitle" id="genre-subtitle">&nbsp;</p>
    </div>

    <div class="averages-grid" id="averages-grid">
      ${Array.from({ length: 7 }).map(() => `<div class="skeleton stat-card" style="height:64px"></div>`).join('')}
    </div>

    <div class="table-wrap" id="table-wrap">
      <div class="loading-state">Loading games…</div>
    </div>
  `;

  try {
    // Load both genre list (for sidebar) + genre detail in parallel
    const [genres, data] = await Promise.all([loadGenres(), loadGenre(slug)]);
    renderSidebarGenres(genres, slug);
    currentGenreData = data;

    document.getElementById('genre-title').textContent = `Top ${data.name} Games`;
    const meta = [
      `${data.games.length} game${data.games.length === 1 ? '' : 's'}`,
      'Updated bi-weekly',
      `Last refresh: ${fmt.relTime(data.last_refresh)}`,
      data.next_refresh ? `Next: ${fmt.date(data.next_refresh)}` : null,
    ].filter(Boolean).join(' · ');
    document.getElementById('genre-subtitle').textContent = meta;

    renderAverages(data.averages);
    renderTable(data.games);
  } catch (err) {
    document.getElementById('genre-title').textContent = 'Genre not found';
    document.getElementById('genre-subtitle').textContent = '';
    document.getElementById('averages-grid').innerHTML = '';
    document.getElementById('table-wrap').innerHTML = `
      <div class="error-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <div>${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

function renderAverages(avg) {
  const grid = document.getElementById('averages-grid');
  if (!avg) { grid.innerHTML = ''; return; }
  const cards = [
    { label: 'Avg Price (MSRP×.66)', value: fmt.price(avg.avg_msrp_usd_cents ? Math.round(avg.avg_msrp_usd_cents * 0.66) : null) },
    { label: 'Median Units Sold', value: fmt.num(avg.median_estimated_owners ?? avg.avg_estimated_owners) },
    { label: 'Median Est. Gross Sales', value: fmt.money(avg.median_estimated_gross_sales_usd_cents ?? avg.avg_estimated_gross_sales_usd_cents) },
    { label: 'Median Hrs/Player', value: fmt.hours(avg.avg_hours_median) },
    { label: 'Avg Daily Peak CCU', value: fmt.numFull(avg.avg_daily_peak_ccu) },
    { label: 'Avg Reviews', value: fmt.numFull(avg.avg_reviews) },
    { label: 'Avg Positive %', value: fmt.pct(avg.avg_positive_percent) },
  ];
  grid.innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.value}</div>
    </div>
  `).join('');
}

function renderTable(games) {
  const wrap = document.getElementById('table-wrap');
  if (!games || !games.length) {
    wrap.innerHTML = `<div class="empty-state">No games in this genre yet.</div>`;
    return;
  }

  const cols = [
    { key: 'name',                          label: 'Game',           sortable: true,  align: 'left',  render: renderGameCell },
    { key: 'release_date',                  label: 'Released',       sortable: true,  align: 'left',  render: g => fmt.date(g.release_date) },
    { key: 'current_price_usd_cents',       label: 'Avg Price (MSR…)', sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.price(g.current_price_usd_cents) },
    { key: 'estimated_owners',              label: 'Est. Owners',    sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.num(g.estimated_owners) },
    { key: 'estimated_gross_sales_usd_cents', label: 'Est. Gross',  sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.money(g.estimated_gross_sales_usd_cents) },
    { key: 'hours_median',                  label: 'Median Hrs/Pl…', sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.hours(g.hours_median) },
    { key: 'avg_daily_peak_ccu_14d',        label: 'Avg Peak',       sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.numFull(g.avg_daily_peak_ccu_14d) },
    { key: 'current_ccu',                   label: 'Current',        sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.numFull(g.current_ccu) },
    { key: 'total_reviews',                 label: 'Reviews',        sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : fmt.numFull(g.total_reviews) },
    { key: 'positive_percent',              label: 'Pos %',          sortable: true,  align: 'right', render: g => g.is_prerelease ? '<span class="muted-dash">—</span>' : `<span class="pos-pct ${posPctClass(g.positive_percent)}">${fmt.pct(g.positive_percent)}</span>` },
    // Platform Mix overlay — personal view, non-sortable. See PM_* block at top of file.
    // The column header has no sort affordance because the badge is per-user state,
    // not a property of the game row. Matches howmanyareplaying's GenrePage column.
    { key: '_platform_mix',                 label: '+ Platforms',    sortable: false, align: 'center', render: g => pmRenderBadge(g) },
  ];

  const sorted = sortGames(games, currentSort.key, currentSort.dir);

  wrap.innerHTML = `
    <table class="games-table">
      <thead>
        <tr>
          ${cols.map(c => {
            const isSorted = c.key === currentSort.key;
            const arrow = isSorted && c.sortable !== false ? (currentSort.dir === 'asc' ? '▲' : '▼') : '';
            const sortableAttr = c.sortable === false ? 'data-sortable="false" style="cursor:default"' : '';
            return `<th class="${isSorted ? 'sorted' : ''} ${c.sortable === false ? 'no-sort' : ''}" data-key="${c.key}" ${sortableAttr} style="text-align:${c.align}">
              ${escapeHtml(c.label)}<span class="sort-arrow">${arrow}</span>
            </th>`;
          }).join('')}
        </tr>
      </thead>
      <tbody>
        ${sorted.map(g => `
          <tr>
            ${cols.map(c => `
              <td class="${c.align === 'right' ? 'num-cell' : ''}" style="text-align:${c.align}">
                ${c.render(g)}
              </td>
            `).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // Wire sort handlers — skip the non-sortable Platform Mix column
  wrap.querySelectorAll('th[data-key]').forEach(th => {
    if (th.dataset.sortable === 'false') return;
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.key = key;
        currentSort.dir = 'desc';
      }
      renderTable(currentGenreData.games);
    });
  });

  // Wire badge clicks (delegated, so re-renders don't lose handlers)
  wrap.addEventListener('click', pmHandleBadgeClick);
}

function renderGameCell(g) {
  const badge = g.is_prerelease
    ? `<span class="prerelease-badge">Pre-release</span>`
    : '';
  const releaseInfo = g.is_prerelease && g.release_date
    ? `<div style="font-size:.6875rem;color:var(--text-dim);margin-top:2px">Launches ${fmt.date(g.release_date)}</div>`
    : '';
  return `
    <div class="game-cell">
      ${g.header_image ? `<img class="game-thumb" src="${escapeAttr(g.header_image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="game-name">
        <a href="https://store.steampowered.com/app/${g.appid}" target="_blank" rel="noopener">${escapeHtml(g.name)}</a>${badge}
        ${releaseInfo}
      </div>
    </div>
  `;
}

function sortGames(games, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...games].sort((a, b) => {
    let av = a[key], bv = b[key];

    // Pre-release games sink to bottom regardless of sort direction
    if (a.is_prerelease && !b.is_prerelease) return 1;
    if (!a.is_prerelease && b.is_prerelease) return -1;

    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * mult;
    }
    return (av - bv) * mult;
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Router ─────────────────────────────────────────────────────────────────
function route() {
  const hash = window.location.hash.slice(1) || '/';
  const match = hash.match(/^\/genres\/([^/?#]+)/);

  if (match) {
    currentSort = { key: 'estimated_gross_sales_usd_cents', dir: 'desc' };
    renderGenreDetail(decodeURIComponent(match[1]));
  } else {
    renderIndex();
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
