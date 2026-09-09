#!/usr/bin/env bash
set -uo pipefail
echo "===== full saber-auth-fix backup file ====="
cat -A /etc/nginx/sites-available/sentimentpulse.bak.1786650765.saber-auth-fix 2>&1 | sed 's/\$$//'
echo
echo "===== diff between live current sentimentpulse and the saber-auth-fix backup ====="
diff /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-available/sentimentpulse.bak.1786650765.saber-auth-fix 2>&1
echo
echo "===== is there a static login.html file anywhere under saber-auth ====="
find /opt/saber-auth -iname "*login*" -o -iname "*admin*" 2>&1 | head -30
echo
echo "===== timestamps: when did each sentimentpulse conf variant last change ====="
ls -la --time-style=full-iso /etc/nginx/sites-available/sentimentpulse /etc/nginx/sites-available/sentimentpulse.bak.* 2>&1
