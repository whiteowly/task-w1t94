#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DATABASE_URL:-./data/app.db}"
EXPORT_PATH="${EXPORT_DIR:-./data/exports}"

if [[ "${DB_PATH}" != ":memory:" ]]; then
  mkdir -p "$(dirname "${DB_PATH}")"
fi

mkdir -p "${EXPORT_PATH}"

if [[ -f "./dist/scripts/init-db.js" ]]; then
  node ./dist/scripts/init-db.js
else
  npm run db:init
fi
