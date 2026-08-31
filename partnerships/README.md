# Partnerships

Saber Publishing Partnerships Dashboard — a sub-app in the Saber Intelligence
Suite. Full specification lives in
[`docs/partnerships/README.md`](../docs/partnerships/README.md).

## Stack

Mirrors `triptracker/` and `signalpulse/`:

- **Server:** Node 20 + Express 5 + TypeScript (tsx in dev, esbuild bundle in prod)
- **Client:** React 18 + Vite + Tailwind
- **DB:** Postgres via Drizzle ORM
- **Auth (planned):** saber-auth (staged `both` → `saber`, same as SignalPulse)

## Local dev

```bash
cd partnerships
npm install
npm run dev            # API on http://127.0.0.1:5002 (PORT overridable)
# in a second shell for the client:
npx vite               # Vite dev server, proxied under /partnerships/ in prod
```

Health check:

```bash
curl http://127.0.0.1:5002/api/health
# → { "ok": true, "app": "partnerships", "version": "0.1.0", "time": "..." }
```

## Production

Behind nginx at `http://104.236.239.46/partnerships/`:

- Static assets served from `/opt/sentimentpulse/partnerships/dist/public/`
- API proxied at `/partnerships/api/*` → `127.0.0.1:5002/api/*`
- Systemd unit: `partnerships.service` (added in the deploy-wiring PR)
- Deploy workflow: `.github/workflows/partnerships-deploy.yml` (added in the
  deploy-wiring PR)

## What's here today (scaffold PR)

- Build tooling (`package.json`, `tsconfig.json`, `vite.config.ts`,
  `tailwind.config.ts`, `postcss.config.js`, `drizzle.config.ts`,
  `components.json`, `script/build.ts`)
- Express server with `GET /api/health` and a placeholder `GET /api/titles`
- Empty Vite/React client that pings health and renders a "coming soon" shell
- Empty Drizzle schema (`shared/schema.ts`) — populated in PR 3

## What's coming next

See [`docs/partnerships/README.md`](../docs/partnerships/README.md#follow-up-prs)
for the 7-PR follow-up plan. Immediate next PR is **deploy wiring** (nginx +
systemd + GitHub Actions workflow).
