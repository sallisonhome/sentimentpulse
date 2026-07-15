# GTM Slide Pack Studio — Frontend

5th app in the Saber Intelligence Suite. Vite + React + Tailwind CSS v3 + wouter (hash routing).

## Stack

- **Vite 5** — bundler / dev server
- **React 18** — UI
- **Tailwind CSS v3** — styling (NOT v4; v3 syntax: `@tailwind base/components/utilities`)
- **wouter** with `useHashLocation` — routing (the app is served from `/gtm/` and lives inside a suite, so path-based routing is unsafe)
- **Inter** (rsms.me CDN) — UI body font

No state library — React `useState` + URL query params hold app state. `localStorage` is only used for the explicit user-initiated "Save draft" feature in the wizard.

## Routes (all under `/gtm/#/…`)

| Route                  | Page                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `/`                    | Home — 3 cards (library / new / example) + admin link                             |
| `/library`             | Deck library — grid + search/theme/date filters; PPTX / PDF / clone buttons       |
| `/new`                 | 6-step wizard (Theme → Game → Cohorts·USPs·Reach → Commercial potential → Risks → Description & razors); step in `?step=` |
| `/preview/:sessionId`  | 6 PNG slides + edit chips + theme toggle + Generate Final Deck                    |
| `/decks/:deckId`       | Download — two large buttons for PPTX and PDF                                     |
| `/example`             | Example viewer — 6-slide click-through + caption rail                             |
| `/admin`               | Stub login (real auth lands in Phase 6)                                           |

## API contract

All API calls go to **`/gtm/api/*`** (relative). In production Nginx proxies that path to the FastAPI backend. In development, `vite.config.ts` proxies it to `http://104.236.239.46` so live calls work.

Endpoints consumed (see `src/lib/api.ts`):

```
GET  /gtm/api/health
GET  /gtm/api/defaults/roadmap_phases
GET  /gtm/api/library?theme&q&from_date&to_date&page&page_size
GET  /gtm/api/library/{id}
GET  /gtm/api/library/{id}/download?format=pptx|pdf
GET  /gtm/api/library/{id}/clone
POST /gtm/api/preview                 body: {inputs, theme}
POST /gtm/api/preview/{id}/regenerate body: {inputs, theme}
GET  /gtm/api/preview/{id}/png/{name}
POST /gtm/api/preview/{id}/commit     body: {is_private}
GET  /gtm/api/example
```

## Design tokens

Locked in `tailwind.config.js` to match the slide deck:

```
bg            #0E1116
surface       #161A21
border        #1F2530
ink           #E8E6E1
muted         #8A8F99
accent        #FFB454  (warm gold — dark deck theme)
light-accent  #1F9B8E  (teal — light deck theme)
```

Default UI chrome is **dark**, matching the other 4 suite apps. The deck theme toggle (gold ↔ teal) only affects slide previews — not the UI.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173/gtm/   (proxies /gtm/api → droplet)
npm run build    # → dist/                       (static bundle for Nginx)
npm run preview  # serve the built bundle locally
```

## Deploy

The build emits to `dist/` ready to be served by Nginx at `/gtm/`. Nginx must:

1. Serve `dist/` at `/gtm/` with a SPA fallback to `/gtm/index.html`.
2. Proxy `/gtm/api/*` to the FastAPI backend (preserving the prefix).

`vite.config.ts` already sets `base: "/gtm/"` so all asset URLs resolve correctly under the subpath.

## Notes

- **No localStorage for app state.** The wizard step is held in `?step=`, the clone payload in `?clone=`. Form draft persistence is the only `localStorage` use, and only behind the explicit "Save draft" button.
- **Hash routing** (`/gtm/#/library`, etc.) is mandatory — the bundle is static, served from a subpath, and lives inside a multi-app suite. Path routing would require server rewrites that may not be guaranteed in every deploy target.
- **Sidebar** matches the other suite apps' visual pattern (logo + Apps section + section labels + cross-app links). Cross-app links use full-page navigation (anchor `href=/sentiment/` etc) to break out of the GTM hash router.
