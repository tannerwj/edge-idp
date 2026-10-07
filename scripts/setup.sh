#!/usr/bin/env bash
# One-click setup for a new Johnson ID instance.
# Usage: ./scripts/setup.sh
# Prompts for ISSUER and RP_NAME, creates D1, sets secrets, applies migrations, deploys.
set -euo pipefail

echo "=== Johnson ID setup ==="
echo ""

# Check prerequisites
command -v npx >/dev/null || { echo "Node/npx not found. Install Node 22+ first."; exit 1; }

read -rp "Your auth domain (e.g. https://auth.example.com): " ISSUER
read -rp "Display name (e.g. Johnson ID): " RP_NAME

ISSUER="${ISSUER%/}"  # strip trailing slash

if [[ ! "$ISSUER" =~ ^https://[^/]+$ ]]; then
  echo "ISSUER must be an https origin with no path, e.g. https://auth.example.com"
  exit 1
fi

echo ""
echo "Creating D1 database..."
DB_JSON=$(npx wrangler d1 create identity --json)
DB_ID=$(echo "$DB_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['uuid'])")
echo "D1 created: $DB_ID"

echo ""
echo "Updating wrangler.toml..."
python3 - "$ISSUER" "$RP_NAME" "$DB_ID" << 'PYEOF'
import sys, re
issuer, rp_name, db_id = sys.argv[1], sys.argv[2], sys.argv[3]
with open("wrangler.toml") as f: c = f.read()
c = re.sub(r'ISSUER = "[^"]*"', f'ISSUER = "{issuer}"', c)
c = re.sub(r'RP_NAME = "[^"]*"', f'RP_NAME = "{rp_name}"', c)
c = re.sub(r'database_id = "[^"]*"', f'database_id = "{db_id}"', c)
with open("wrangler.toml", "w") as f: f.write(c)
print("wrangler.toml updated")
PYEOF

echo ""
echo "Generating signing key..."
node scripts/gen-key.mjs > /tmp/johnson-id-key.json
KEY_JSON=$(cat /tmp/johnson-id-key.json)
echo "$KEY_JSON" | npx wrangler secret put SIGNING_KEY_JWK
shred -u /tmp/johnson-id-key.json 2>/dev/null || rm -f /tmp/johnson-id-key.json
echo "Signing key set."

echo ""
echo "Applying migrations..."
npx wrangler d1 migrations apply identity --remote

echo ""
echo "Building and deploying..."
npm run deploy

echo ""
echo "=== Done! ==="
echo "Your identity provider is live at: $ISSUER"
echo ""
echo "Next steps:"
echo "1. Add a DNS record pointing your domain to the worker (see DEPLOY.md)"
echo "2. Create your admin account: npx wrangler d1 execute identity --remote --command \"...\" (see DEPLOY.md)"
echo "3. Visit $ISSUER/admin to manage users, apps, and themes"
