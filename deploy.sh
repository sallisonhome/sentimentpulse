#!/usr/bin/env bash
# ── Saber Intelligence Suite Deployment (Ubuntu 24.04) ───────────────────────
# Deploys SentimentPulse, SignalPulse, and Trip Tracker under one Nginx server.
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
  echo "[0/11] Configuring 3 GB swap..."
  fallocate -l 3G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "[0/11] Swap already configured."
fi

# ── 1. System packages ──────────────────────────────────────────────────────
echo "[1/11] Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nodejs nginx git ufw curl > /dev/null

# ── 2. PostgreSQL (for Trip Tracker) ────────────────────────────────────────
echo "[2/11] Setting up PostgreSQL..."
if ! command -v psql &>/dev/null; then
  apt-get install -y -qq postgresql postgresql-contrib > /dev/null
fi
systemctl enable postgresql
systemctl start postgresql

# Create the database and user if they don't exist
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='egs'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER egs WITH PASSWORD 'egspassword';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='egs_trip_tracker'" | grep -q 1 || \
  sudo -u postgres createdb -O egs egs_trip_tracker
echo "  PostgreSQL ready."

# ── 3. Firewall ─────────────────────────────────────────────────────────────
echo "[3/11] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 4. Clone / update repo ──────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "[4/11] Updating existing repo..."
  cd "$APP_DIR" && git pull || true
else
  echo "[4/11] Cloning repository..."
  git clone https://github.com/sallisonhome/sentimentpulse.git "$APP_DIR"
fi
cd "$APP_DIR"

# ── 5. SentimentPulse backend (Python) ──────────────────────────────────────
echo "[5/11] Setting up SentimentPulse backend..."
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

INGEST_HOUR=10
INGEST_MINUTE=45
REDDIT_GIST_URL=https://gist.githubusercontent.com/sallisonhome/18675b3d910f4555251b666a65a6874a/raw/reddit_data.json
ENVEOF
  echo "  ⚠  Set ANTHROPIC_API_KEY in /opt/sentimentpulse/.env"
fi

alembic upgrade head
python fix_subreddits.py
deactivate

# ── 6. SentimentPulse frontend ──────────────────────────────────────────────
echo "[6/11] Building SentimentPulse frontend..."
cd "$APP_DIR/frontend"
npm config set registry https://registry.npmjs.org/
rm -f package-lock.json
npm install
echo '/// <reference types="vite/client" />' > src/vite-env.d.ts
npm run build

# ── 7. SignalPulse (Node.js) ────────────────────────────────────────────────
echo "[7/11] Building SignalPulse..."
cd "$APP_DIR/signalpulse"
npm config set registry https://registry.npmjs.org/
npm install
npm run build

# ── 8. Trip Tracker (Node.js + PostgreSQL) ──────────────────────────────────
echo "[8/11] Building Trip Tracker..."
cd "$APP_DIR/triptracker"
npm config set registry https://registry.npmjs.org/
npm install
npm run build

# ── 9. Systemd services ────────────────────────────────────────────────────
echo "[9/11] Creating systemd services..."

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

# Trip Tracker (Node.js/Express on port 5001 + PostgreSQL)
cat > /etc/systemd/system/triptracker.service << 'EOF'
[Unit]
Description=Trip Tracker API
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sentimentpulse/triptracker
Environment="NODE_ENV=production"
Environment="PORT=5001"
Environment="DATABASE_URL=postgresql://egs:egspassword@localhost:5432/egs_trip_tracker"
EnvironmentFile=/opt/sentimentpulse/.env
ExecStart=/usr/bin/node dist/index.cjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sentimentpulse signalpulse triptracker
systemctl restart sentimentpulse
systemctl restart signalpulse
systemctl restart triptracker

# ── 10. Nginx ───────────────────────────────────────────────────────────────
echo "[10/11] Configuring Nginx..."
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

    # Trip Tracker frontend
    location /trips/ {
        alias /opt/sentimentpulse/triptracker/dist/public/;
        index index.html;
        try_files \$uri \$uri/ /trips/index.html;
    }

    # Trip Tracker API
    location /trips/api/ {
        proxy_pass http://127.0.0.1:5001/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    # Genre Pulse — static frontend (mirrors howmanyareplaying.com)
    location /genrepulse/ {
        alias /opt/sentimentpulse/genrepulse/;
        index index.html;
        try_files \$uri \$uri/ /genrepulse/index.html;
    }

    # Genre Pulse — reverse proxy to howmanyareplaying.com to bypass CORS
    location /genrepulse/api/ {
        proxy_pass https://www.howmanyareplaying.com/api/;
        proxy_ssl_server_name on;
        proxy_set_header Host www.howmanyareplaying.com;
        proxy_set_header Origin https://howmanyareplaying.com;
        proxy_set_header User-Agent "GenrePulse/1.0 (Saber Intelligence Suite)";
        proxy_set_header Accept "application/json";
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
        # Cache upstream responses for 5 minutes (data is bi-weekly)
        proxy_cache_valid 200 5m;
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Credentials;
        add_header Access-Control-Allow-Origin "\$http_origin" always;
        add_header Access-Control-Allow-Credentials "true" always;
    }
}
EOF

ln -sf /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
echo 'client_max_body_size 50M;' > /etc/nginx/conf.d/upload_limit.conf
nginx -t
systemctl restart nginx

# ── 11. Done ────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✓ Deployment complete!"
echo ""
echo "  Suite URL:        http://${SERVER_IP}"
echo "  Password:         SABER"
echo "  SentimentPulse:   http://${SERVER_IP}/sentiment/"
echo "  SignalPulse:      http://${SERVER_IP}/signal/"
echo "  Trip Tracker:     http://${SERVER_IP}/trips/"
echo "  Genre Pulse:      http://${SERVER_IP}/genrepulse/"
echo "  GTM Studio:       http://${SERVER_IP}/gtm/"
echo ""
echo "  Services:"
echo "    systemctl status gtmstudio"
echo "    systemctl status sentimentpulse"
echo "    systemctl status signalpulse"
echo "    systemctl status triptracker"
echo "══════════════════════════════════════════════════════════════"
