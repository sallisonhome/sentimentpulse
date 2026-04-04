#!/usr/bin/env bash
# ── SentimentPulse Deployment Script (Ubuntu 24.04, 1GB droplet) ─────────────
# Run as root on a fresh DigitalOcean droplet. Handles everything:
#   swap, packages, clone, backend, frontend, systemd, Nginx.
#
# Usage:
#   git clone https://github.com/sallisonhome/sentimentpulse.git /opt/sentimentpulse
#   bash /opt/sentimentpulse/deploy.sh
#
# Or on an existing install:
#   cd /opt/sentimentpulse && git pull && bash deploy.sh
set -euo pipefail

echo "══════════════════════════════════════════════════════════════"
echo "  SentimentPulse — Deploying to production"
echo "══════════════════════════════════════════════════════════════"

APP_DIR="/opt/sentimentpulse"

# ── 0. Swap (skip if already configured) ─────────────────────────────────────
if [ "$(swapon --show | wc -l)" -le 1 ]; then
  echo "[0/7] Configuring 3 GB swap..."
  fallocate -l 3G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  Swap enabled."
else
  echo "[0/7] Swap already configured — skipping."
fi

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nodejs npm nginx git ufw curl > /dev/null

# ── 2. Firewall ──────────────────────────────────────────────────────────────
echo "[2/7] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 3. Clone / update repo ──────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "[3/7] Updating existing repo..."
  cd "$APP_DIR" && git pull || true
else
  echo "[3/7] Cloning repository..."
  git clone https://github.com/sallisonhome/sentimentpulse.git "$APP_DIR"
fi
cd "$APP_DIR"

# ── 4. Backend setup ─────────────────────────────────────────────────────────
echo "[4/7] Setting up Python backend..."
cd "$APP_DIR/backend"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements-light.txt -q

# Create .env from template if missing
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i 's/LIGHTWEIGHT_NLP=false/LIGHTWEIGHT_NLP=true/' "$APP_DIR/.env"

  # Set sensible defaults for Saber Interactive
  sed -i 's/^PUBLISHER_NAME=$/PUBLISHER_NAME=Saber Interactive/' "$APP_DIR/.env"
  sed -i 's/^DEVELOPER_NAME=$/DEVELOPER_NAME=Saber Interactive/' "$APP_DIR/.env"

  # Set ingestion time to 10:45 AM (after the PC Reddit fetcher at 10:00 AM)
  echo '' >> "$APP_DIR/.env"
  echo '# ── Schedule ─────────────────────────────────────────────────────────────────' >> "$APP_DIR/.env"
  echo 'INGEST_HOUR=10' >> "$APP_DIR/.env"
  echo 'INGEST_MINUTE=45' >> "$APP_DIR/.env"

  # Reddit Gist URL (populated by home PC fetcher)
  echo '' >> "$APP_DIR/.env"
  echo '# ── Reddit data ──────────────────────────────────────────────────────────────' >> "$APP_DIR/.env"
  echo 'REDDIT_GIST_URL=https://gist.githubusercontent.com/sallisonhome/18675b3d910f4555251b666a65a6874a/raw/reddit_data.json' >> "$APP_DIR/.env"

  echo ""
  echo "  ⚠  IMPORTANT: Edit /opt/sentimentpulse/.env and set:"
  echo "     - ANTHROPIC_API_KEY=sk-ant-..."
  echo ""
fi

# Run database migrations
alembic upgrade head

# Populate subreddit mappings
python fix_subreddits.py

deactivate

# ── 5. Frontend build ────────────────────────────────────────────────────────
echo "[5/7] Building frontend..."
cd "$APP_DIR/frontend"

# Force public npm registry (avoid stale private registry in lock file)
npm config set registry https://registry.npmjs.org/
rm -f package-lock.json
npm install

# Ensure Vite client types exist for TypeScript
echo '/// <reference types="vite/client" />' > src/vite-env.d.ts

npm run build

# ── 6. Systemd service ──────────────────────────────────────────────────────
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/sentimentpulse.service << 'EOF'
[Unit]
Description=SentimentPulse API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sentimentpulse/backend
Environment="PATH=/opt/sentimentpulse/backend/.venv/bin:/usr/bin"
EnvironmentFile=/opt/sentimentpulse/.env
ExecStart=/opt/sentimentpulse/backend/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sentimentpulse
systemctl restart sentimentpulse

# ── 7. Nginx config ──────────────────────────────────────────────────────────
echo "[7/7] Configuring Nginx..."

SERVER_IP=$(curl -s http://checkip.amazonaws.com || echo "YOUR_IP")

cat > /etc/nginx/sites-available/sentimentpulse << EOF
server {
    listen 80;
    server_name ${SERVER_IP};

    root /opt/sentimentpulse/frontend/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /health {
        proxy_pass http://127.0.0.1:8000/health;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl restart nginx

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✓ Deployment complete!"
echo ""
echo "  App URL:    http://${SERVER_IP}"
echo "  Password:   SABER"
echo "  Ingestion:  Daily at 10:45 AM (server local time)"
echo "  Reddit:     Fed by home PC fetcher via GitHub Gist"
echo ""
echo "  Only remaining step:"
echo "  1. nano /opt/sentimentpulse/.env"
echo "     → Set ANTHROPIC_API_KEY=sk-ant-..."
echo "  2. systemctl restart sentimentpulse"
echo ""
echo "  After setting the key, trigger first ingestion:"
echo "  curl -X POST http://127.0.0.1:8000/api/ingest/run"
echo "══════════════════════════════════════════════════════════════"
