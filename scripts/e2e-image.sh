#!/usr/bin/env bash
# Browser tests (Playwright, e2e/) against the built docker image: builds and starts the compose
# box as its own project on its own port, seeds a member user through the image's CLI, runs
# `playwright test` with E2E_BASE_URL and the credentials (E2E_ADMIN_*, E2E_MEMBER_LOGIN) in the
# environment, then `docker compose down -v`. Extra arguments go to `playwright test`.
# Needs docker, `pnpm install` and `pnpm exec playwright install chromium`. E2E_BROWSERS (comma
# list, default chromium) adds firefox/webkit projects; install those browsers the same way.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${E2E_PROJECT:-skills-e2e}"
PORT="${E2E_PORT:-38081}"
BASE_URL="http://localhost:${PORT}"
HEALTH_TIMEOUT=120

# The admin the box seeds on start; the browser tests sign in as it (E2E_ADMIN_*).
ADMIN_LOGIN=admin
ADMIN_PASSWORD="$(openssl rand -base64 18)"
# Seeded through the image's CLI below, so the users page has someone besides the admin.
MEMBER_LOGIN=e2e-member

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/skills-e2e-env.XXXXXX")"
export ENV_FILE
cat >"$ENV_FILE" <<EOF
PORT=${PORT}
PUBLIC_URL=${BASE_URL}
COOKIE_SECURE=false
POSTGRES_PASSWORD=$(openssl rand -base64 32)
ADMIN_LOGIN=${ADMIN_LOGIN}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
LOG_LEVEL=warn
EOF

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then compose logs --no-color --tail 80 app || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  exit "$code"
}
trap cleanup EXIT

compose up -d --build

deadline=$((SECONDS + HEALTH_TIMEOUT))
until [ "$(curl -fsS "${BASE_URL}/healthz" 2>/dev/null || true)" = "ok" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FAIL: /healthz did not return ok in ${HEALTH_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 2
done

# The member exists only so the users page has someone besides the admin.
openssl rand -base64 18 | compose exec -T app node dist/cli.js create-user "$MEMBER_LOGIN" --role member

E2E_BASE_URL="$BASE_URL" E2E_ADMIN_LOGIN="$ADMIN_LOGIN" E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  E2E_MEMBER_LOGIN="$MEMBER_LOGIN" pnpm exec playwright test -c e2e/playwright.config.ts "$@"
