#!/usr/bin/env bash
set -uo pipefail

echo "===== nginx -t ====="
nginx -t 2>&1

echo
echo "===== live nginx sites-enabled listing ====="
ls -la /etc/nginx/sites-enabled/ 2>&1

echo
echo "===== live sentimentpulse.conf (full) ====="
cat /etc/nginx/sites-enabled/sentimentpulse* 2>&1 || cat /etc/nginx/sites-available/sentimentpulse* 2>&1

echo
echo "===== grep for 'auth' across all live nginx conf files ====="
grep -rn -i "auth" /etc/nginx/sites-enabled/ /etc/nginx/sites-available/ /etc/nginx/conf.d/ 2>/dev/null

echo
echo "===== any .bak or stray files in sites-enabled/available ====="
find /etc/nginx/sites-enabled /etc/nginx/sites-available -maxdepth 1 -type f 2>&1

echo
echo "===== systemd services matching saber/signal/promo/partnership/console/sentimentpulse ====="
systemctl list-units --type=service --all 2>&1 | grep -iE "saber|signal|promo|partner|console|sentiment" 

echo
echo "===== saber-auth service status (if exists) ====="
systemctl status saber-auth --no-pager 2>&1 | head -30

echo
echo "===== ports currently listening ====="
ss -tlnp 2>&1 | grep -E ":5000|:5001|:5002|:5003|:5004|:8000|:80 " 

echo
echo "===== is there a /opt/saber-auth or similar dir ====="
ls -la /opt/ 2>&1
