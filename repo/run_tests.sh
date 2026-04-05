#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${APP_ENCRYPTION_KEY_B64:-}" ]]; then
  APP_ENCRYPTION_KEY_B64="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
  export APP_ENCRYPTION_KEY_B64
fi

trap 'docker compose down --remove-orphans' EXIT

docker compose --profile test build test
docker compose --profile test run --rm test
