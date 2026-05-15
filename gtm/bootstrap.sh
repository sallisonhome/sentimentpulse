#!/usr/bin/env bash
# GTM Slide Pack Studio — droplet bootstrap (Phases 0 + 1, backend only).
# Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="/opt/sentimentpulse"
GTM_ROOT="${REPO_ROOT}/gtm"
BACKEND="${GTM_ROOT}/backend"
VENV="${BACKEND}/.venv"
STORAGE="/var/lib/gtm"
LOG="GTM bootstrap"

echo "[1/7] System packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y \
  python3 python3-venv python3-pip \
  libreoffice-core libreoffice-impress \
  poppler-utils \
  ttf-mscorefonts-installer fontconfig \
  >/dev/null
fc-cache -f >/dev/null

echo "[2/7] Pulling latest code..."
cd "${REPO_ROOT}"
git pull >/dev/null

echo "[3/7] Python venv + deps..."
if [ ! -d "${VENV}" ]; then
  python3 -m venv "${VENV}"
fi
"${VENV}/bin/pip" install --upgrade pip --quiet
"${VENV}/bin/pip" install -r "${BACKEND}/requirements.txt" --quiet

echo "[4/7] Storage dirs..."
mkdir -p "${STORAGE}/library" "${STORAGE}/trash" "${STORAGE}/preview"
chown -R www-data:www-data "${STORAGE}"

echo "[4b/7] Seeding example pack PNGs..."
if [ ! -f "${BACKEND}/static_example/dark/1.png" ] || [ "${REBUILD_EXAMPLE:-0}" = "1" ]; then
  "${VENV}/bin/python" "${BACKEND}/scripts/seed_example_pack.py"
else
  echo "  example PNGs already present (set REBUILD_EXAMPLE=1 to re-render)"
fi

echo "[5a/7] Building frontend..."
if command -v npm >/dev/null 2>&1; then
  cd "${GTM_ROOT}/frontend"
  npm install --silent --no-audit --no-fund
  npm run build --silent
  cd "${REPO_ROOT}"
else
  echo "  WARNING: npm not available, skipping frontend build"
fi

echo "[5/7] Systemd service..."
cp "${GTM_ROOT}/systemd/gtmstudio.service" /etc/systemd/system/gtmstudio.service
systemctl daemon-reload
systemctl enable gtmstudio >/dev/null
systemctl restart gtmstudio

echo "[5b/7] Installing trash-purge cron..."
cat > /etc/cron.d/gtm-trash-purge <<'CRON'
# GTM Slide Pack — nightly purge of trash older than 30 days. 03:00 UTC.
0 3 * * * root GTM_DB_PATH=/var/lib/gtm/db.sqlite GTM_STORAGE_ROOT=/var/lib/gtm /opt/sentimentpulse/gtm/backend/.venv/bin/python /opt/sentimentpulse/gtm/backend/scripts/purge_old_trash.py >> /var/log/gtm-trash-purge.log 2>&1
CRON
chmod 644 /etc/cron.d/gtm-trash-purge

echo "[6/7] Waiting for service to come up..."
sleep 3
systemctl is-active --quiet gtmstudio && echo "  service: active" || {
  echo "  service: FAILED"
  journalctl -u gtmstudio --no-pager -n 30
  exit 1
}

echo "[7/7] Smoke test..."
HEALTH=$(curl -s http://127.0.0.1:8001/health || echo '{}')
echo "  /health → ${HEALTH}"

echo ""
echo "✓ GTM backend running on 127.0.0.1:8001"
echo ""
echo "Next steps (do NOT run yet — these come in Phase 7):"
echo "  - Add /gtm/ Nginx location + proxy"
echo "  - Build frontend (Phase 2)"
echo "  - Wire launcher tile"
echo ""
echo "Quick test:"
echo "  curl -s http://127.0.0.1:8001/health"
echo "  curl -s http://127.0.0.1:8001/library | python3 -m json.tool"
