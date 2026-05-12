#!/bin/bash
set -e

echo "=== Skagit Pipeline Setup ==="
echo ""

echo "1. Installing dependencies..."
npm install

echo ""
echo "2. Creating R2 bucket (raw-parcels)..."
wrangler r2 bucket create raw-parcels 2>/dev/null || echo "   (bucket may already exist, continuing)"

echo ""
echo "3. Running D1 schema..."
wrangler d1 execute skagit-parcels --file=schema.sql

echo ""
echo "4. Deploying worker..."
wrangler deploy

echo ""
echo "=== Done! ==="
echo ""
echo "Next steps:"
echo "  - Set Worker secrets: ANTHROPIC_API_KEY and ADMIN_INGEST_TOKEN"
echo "  - Run scripts/backfill-geo.js once for bulk geometry, then ONLY_MISSING=1 as needed"
echo "  - GitHub Actions runs ingest weekly Sunday at 2am PST"
echo "  - Worker cron runs geo patching at 3:30am PST"
echo "  - API is live at: https://skagit-parcels.<your-subdomain>.workers.dev"
echo ""
echo "Test it:"
echo "  curl https://skagit-parcels.<your-subdomain>.workers.dev/parcel/<PARCELID>"
