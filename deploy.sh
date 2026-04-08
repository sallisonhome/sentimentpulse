#!/usr/bin/env bash
# ── Saber Intelligence Suite Deployment (Ubuntu 24.04) ───────────────────────
# Deploys both SentimentPulse and SignalPulse under one Nginx server.
#
# Usage:
#   git clone https://github.com/sallisonhome/sentimentpulse.git /opt/sentimentpulse
#   bash /opt/sentimentpulse/deploy.sh
set -euo pipefail

echo "══════════════════════════════════════════════════════════════"
echo "  Saber Intelligence Suite — Deploying"
echo "══════════════════════════════════════════════════════════════"

APP_DIR="/opt/sentimentpulse"

# ── 0. Swap ──────────────────────────────────────────────────────────────────
if [ "$(swapon --show | wc -l)" -le 1 ]; then
  echo "[0/9] Configuring 3 GB swap..."
  fallocate -l 3G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "[0/9] Swap already configured."
fi

# ── 1. System packages ──────────────────────────────────────────────────────
echo "[1/9] Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nodejs nginx git ufw curl > /dev/null

# ── 2. Firewall ─────────────────────────────────────────────────────────────
echo "[2/9] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 3. Clone / update repo ──────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "[3/9] Updating existing repo..."
  cd "$APP_DIR" && git pull || true
else
  echo "[3/9] Cloning repository..."
  git clone https://github.com/sallisonhome/sentimentpulse.git "$APP_DIR"
fi
cd "$APP_DIR"

# ── 4. SentimentPulse backend (Python) ──────────────────────────────────────
echo "[4/9] Setting up SentimentPulse backend..."
cd "$APP_DIR/backend"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements-light.txt -q

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i 's/LIGHTWEIGHT_NLP=false/LIGHTWEIGHT_NLP=true/' "$APP_DIR/.env"
  sed -i 's/^PUBLISHER_NAME=$/PUBLISHER_NAME=Saber Interactive/' "$APP_DIR/.env"
  sed -i 's/^DEVELOPER_NAME=$/DEVELOPER_NAME=Saber Interactive/' "$APP_DIR/.env"
  cat >> "$APP_DIR/.env" << 'ENVEOF'

# ── Schedule ─────────────────────────────────────────────────────────────────
INGEST_HOUR=10
INGEST_MINUTE=45

# ── Reddit data ──────────────────────────────────────────────────────────────
REDDIT_GIST_URL=https://gist.githubusercontent.com/sallisonhome/18675b3d910f4555251b666a65a6874a/raw/reddit_data.json
ENVEOF
  echo ""
  echo "  ⚠  Set ANTHROPIC_API_KEY in /opt/sentimentpulse/.env"
  echo ""
fi

alembic upgrade head
python fix_subreddits.py
deactivate

# ── 5. SentimentPulse frontend ──────────────────────────────────────────────
echo "[5/9] Building SentimentPulse frontend..."
cd "$APP_DIR/frontend"
npm config set registry https://registry.npmjs.org/
rm -f package-lock.json
npm install
echo '/// <reference types="vite/client" />' > src/vite-env.d.ts
npm run build

# ── 6. SignalPulse backend + frontend (Node.js) ─────────────────────────────
echo "[6/9] Building SignalPulse..."
cd "$APP_DIR/signalpulse"
npm config set registry https://registry.npmjs.org/
npm install
npm run build

# ── 7. Systemd services ────────────────────────────────────────────────────
echo "[7/9] Creating systemd services..."

# SentimentPulse (Python/FastAPI on port 8000)
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

# SignalPulse (Node.js/Express on port 5000)
cat > /etc/systemd/system/signalpulse.service << 'EOF'
[Unit]
Description=SignalPulse API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sentimentpulse/signalpulse
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node dist/index.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sentimentpulse signalpulse
systemctl restart sentimentpulse
systemctl restart signalpulse

# ── 8. Nginx ────────────────────────────────────────────────────────────────
echo "[8/9] Configuring Nginx..."
SERVER_IP=$(curl -s http://checkip.amazonaws.com || echo "YOUR_IP")

cat > /etc/nginx/sites-available/sentimentpulse << EOF
server {
    listen 80;
    server_name ${SERVER_IP};

    client_max_body_size 50M;

    # Launcher (root)
    location = / {
        root /opt/sentimentpulse/launcher;
        index index.html;
    }
    location = /index.html {
        root /opt/sentimentpulse/launcher;
    }

    # SentimentPulse frontend
    location /sentiment/ {
        alias /opt/sentimentpulse/frontend/dist/;
        index index.html;
        try_files \$uri \$uri/ /sentiment/index.html;
    }

    # SentimentPulse API
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

    # SignalPulse frontend
    location /signal/ {
        alias /opt/sentimentpulse/signalpulse/dist/public/;
        index index.html;
        try_files \$uri \$uri/ /signal/index.html;
    }

    # SignalPulse API
    location /signal/api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
echo 'client_max_body_size 50M;' > /etc/nginx/conf.d/upload_limit.conf
nginx -t
systemctl restart nginx

# ── 9. Done ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✓ Deployment complete!"
echo ""
echo "  Suite URL:        http://${SERVER_IP}"
echo "  Password:         SABER"
echo "  SentimentPulse:   http://${SERVER_IP}/sentiment/"
echo "  SignalPulse:      http://${SERVER_IP}/signal/"
echo ""
echo "  Services:"
echo "    systemctl status sentimentpulse"
echo "    systemctl status signalpulse"
echo "══════════════════════════════════════════════════════════════"
