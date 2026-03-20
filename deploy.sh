#!/usr/bin/env bash
# ── SentimentPulse Deployment Script (Ubuntu 24.04, 1GB droplet) ─────────────
# Run as root on a fresh DigitalOcean droplet with swap already configured.
set -euo pipefail

echo "══════════════════════════════════════════════════════════════"
echo "  SentimentPulse — Deploying to production"
echo "══════════════════════════════════════════════════════════════"

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nodejs npm nginx git ufw > /dev/null

# ── 2. Firewall ──────────────────────────────────────────────────────────────
echo "[2/7] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 3. Clone repo ────────────────────────────────────────────────────────────
APP_DIR="/opt/sentimentpulse"
if [ -d "$APP_DIR" ]; then
  echo "[3/7] Updating existing repo..."
  cd "$APP_DIR" && git pull
else
  echo "[3/7] Cloning repository..."
  git clone https://github.com/sallisonhome/sentimentpulse.git "$APP_DIR"
fi
cd "$APP_DIR"

# ── 4. Backend setup ─────────────────────────────────────────────────────────
echo "[4/7] Setting up backend..."
cd "$APP_DIR/backend"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements-light.txt -q

# Create .env if it doesn't exist
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Enable lightweight mode
  sed -i 's/LIGHTWEIGHT_NLP=false/LIGHTWEIGHT_NLP=true/' "$APP_DIR/.env"
  echo ""
  echo "  ⚠  IMPORTANT: Edit /opt/sentimentpulse/.env and set:"
  echo "     - PUBLISHER_NAME=Your Studio Name"
  echo "     - ANTHROPIC_API_KEY=sk-ant-..."
  echo ""
fi

# Run migrations
alembic upgrade head

deactivate

# ── 5. Frontend build ────────────────────────────────────────────────────────
echo "[5/7] Building frontend..."
cd "$APP_DIR/frontend"
npm install --legacy-peer-deps 2>/dev/null || npm install
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

# Get the server's public IP
SERVER_IP=$(curl -s http://checkip.amazonaws.com || echo "YOUR_IP")

cat > /etc/nginx/sites-available/sentimentpulse << EOF
server {
    listen 80;
    server_name ${SERVER_IP};

    # Frontend — serve the built Vite app
    root /opt/sentimentpulse/frontend/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Proxy API requests to the FastAPI backend
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

# Enable the site
ln -sf /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl restart nginx

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✓ Deployment complete!"
echo ""
echo "  App URL:  http://${SERVER_IP}"
echo "  Password: SABER"
echo ""
echo "  Next steps:"
echo "  1. Edit /opt/sentimentpulse/.env (set API keys, publisher name)"
echo "  2. Restart: systemctl restart sentimentpulse"
echo "  3. Visit http://${SERVER_IP} and enter password SABER"
echo "══════════════════════════════════════════════════════════════"
