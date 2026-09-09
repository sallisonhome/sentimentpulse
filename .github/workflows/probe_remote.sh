#!/usr/bin/env bash
set -euo pipefail
cd /opt/sentimentpulse/signalpulse

KEY=$(node -e '
const path = require("path");
const Database = require(path.join(process.cwd(), "node_modules", "better-sqlite3"));
const db = new Database("data.db", { readonly: true });
const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("rainforest_api_key");
process.stdout.write(row && row.value ? row.value : "");
' 2>/tmp/dberr.log)

if [ -z "$KEY" ]; then
  KEY="${RAINFOREST_API_KEY:-}"
fi

if [ -z "$KEY" ]; then
  echo "ERROR: could not resolve rainforest key from DB or env"
  cat /tmp/dberr.log || true
  exit 1
fi

NODE_URL="https://www.amazon.com/gp/movers-and-shakers/videogames/20972797011/"
curl -sS "https://api.rainforestapi.com/request" \
  --data-urlencode "api_key=${KEY}" \
  --data-urlencode "type=bestsellers" \
  --data-urlencode "url=${NODE_URL}" \
  -G -o /tmp/probe.json

python3 -c "
import json
d = json.load(open('/tmp/probe.json'))
print(json.dumps(d.get('request_info'), indent=2))
bs = d.get('bestsellers', [])
print('count:', len(bs))
if bs:
    print(json.dumps(bs[0], indent=2))
keys = set()
for item in bs[:5]:
    keys.update(item.keys())
print('union of keys across first 5:', sorted(keys))
"

rm -f /tmp/probe.json /tmp/dberr.log
