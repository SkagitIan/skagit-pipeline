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
echo "  - Run the Colab geo backfill notebook (colab_geo_backfill.py) once"
echo "  - After backfill: upload parcel_geo.csv to R2 or run the seed SQL"
echo "  - Worker crons run nightly: 2am PST ingest, 3:30am PST geo patch"
echo "  - API is live at: https://skagit-parcels.<your-subdomain>.workers.dev"
echo ""
echo "Test it:"
echo "  curl https://skagit-parcels.<your-subdomain>.workers.dev/parcel/<PARCELID>"
