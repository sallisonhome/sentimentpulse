// Genre Pulse — mirrors howmanyareplaying.com Genre Performance Tables
// API is proxied through Nginx at /genrepulse/api/* to bypass CORS.

const API_BASE = '/genrepulse/api';
const main = document.getElementById('main');
const genreSidebarSection = document.getElementById('genre-list-section');
const genreSidebarList = document.getElementById('genre-sidebar-list');

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
    { label: 'Avg Units Sold', value: fmt.num(avg.avg_estimated_owners) },
    { label: 'Avg Est. Gross Sales', value: fmt.money(avg.avg_estimated_gross_sales_usd_cents) },
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
  ];

  const sorted = sortGames(games, currentSort.key, currentSort.dir);

  wrap.innerHTML = `
    <table class="games-table">
      <thead>
        <tr>
          ${cols.map(c => {
            const isSorted = c.key === currentSort.key;
            const arrow = isSorted ? (currentSort.dir === 'asc' ? '▲' : '▼') : '';
            return `<th class="${isSorted ? 'sorted' : ''}" data-key="${c.key}" style="text-align:${c.align}">
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

  // Wire sort handlers
  wrap.querySelectorAll('th[data-key]').forEach(th => {
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
