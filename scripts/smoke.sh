#!/usr/bin/env bash
# End-to-end smoke test of the docker compose deployment:
#   build and start → /healthz = ok → the UI at / with its CSP → container checks
#   → create-token → create the fixture skills through the REST API (log in as the admin,
#   then POST /api/skills per folder of scripts/smoke-fixtures)
#   → MCP search_skills over HTTP (a Russian query against English skills, so only the
#   embedding model can find it) → get_skill → a contrasting query finds the other skill
#   → an unrelated query finds nothing → docker compose down -v.
# Runs as its own compose project with its own env file and port, so it never touches a
# deployment started from .env in the same checkout. Needs docker, node and `pnpm install`.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${SMOKE_PROJECT:-skills-smoke}"
PORT="${SMOKE_PORT:-38080}"
BASE_URL="http://localhost:${PORT}"
HEALTH_TIMEOUT=120
SEARCH_TIMEOUT=120

# The admin the box seeds on start; the fixtures are created as it. Base64 has no characters
# that need escaping in the JSON login body.
ADMIN_LOGIN="admin"
ADMIN_PASSWORD="$(openssl rand -base64 18)"

ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/skills-smoke-env.XXXXXX")"
export ENV_FILE
COOKIE_JAR="$(mktemp "${TMPDIR:-/tmp}/skills-smoke-cookies.XXXXXX")"
cat >"$ENV_FILE" <<EOF
PORT=${PORT}
PUBLIC_URL=${BASE_URL}
COOKIE_SECURE=false
POSTGRES_PASSWORD=$(openssl rand -base64 32)
ADMIN_LOGIN=${ADMIN_LOGIN}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
LOG_LEVEL=info
EOF

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "--- app logs (last 80 lines) ---"
    compose logs --no-color --tail 80 app || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$COOKIE_JAR"
  if [ "$code" -eq 0 ]; then echo "SMOKE OK"; else echo "SMOKE FAILED"; fi
  exit "$code"
}
trap cleanup EXIT

step() { echo "==> $*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

step "docker compose up -d --build"
compose up -d --build

step "waiting for ${BASE_URL}/healthz (up to ${HEALTH_TIMEOUT}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
until [ "$(curl -fsS "${BASE_URL}/healthz" 2>/dev/null || true)" = "ok" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail "/healthz did not return ok in ${HEALTH_TIMEOUT}s"
  sleep 2
done
echo "healthz: ok"

step "web UI: GET / serves index.html with the CSP header"
# -D - puts the response headers in front of the body.
ui_response="$(curl -fsS -H 'Accept: text/html' -D - "${BASE_URL}/")" || fail "GET / failed"
grep -q '<div id="root"></div>' <<<"$ui_response" || fail "GET / did not return index.html with #root"
ui_csp="$(grep -i '^content-security-policy:' <<<"$ui_response" | tr -d '\r' || true)"
grep -q "default-src 'self'" <<<"$ui_csp" || fail "GET / has no CSP header with default-src 'self'"
echo "ui: index.html; ${ui_csp}"

step "container checks"
uid="$(compose exec -T app id -u)"
[ "$uid" != "0" ] || fail "app runs as root"
echo "app uid: ${uid}"
# `compose port` prints nothing, ":0" or (newer Compose) "invalid IP:0" for an unpublished port;
# `docker port` lists every published port of the container, so it must be empty.
db_port="$(compose port db 5432 2>/dev/null || true)"
[ -z "$db_port" ] || [ "${db_port%:0}" != "$db_port" ] || fail "db port 5432 is published: ${db_port}"
db_published="$(docker port "$(compose ps -q db)")"
[ -z "$db_published" ] || fail "db publishes ports: ${db_published}"
echo "db: no published ports"

step "create-token"
token_output="$(compose exec -T app node dist/cli.js create-token admin --name smoke)"
SMOKE_TOKEN="$(printf '%s\n' "$token_output" | head -n 1)"
[[ "$SMOKE_TOKEN" =~ ^sk_ ]] || fail "create-token did not print an sk_ token"
printf '%s\n' "$token_output" | sed -n '2p' | grep -q '^claude mcp add --transport http skills ' ||
  fail "create-token did not print the claude mcp add command"
echo "token: ${SMOKE_TOKEN:0:10}… (connect command printed)"
export SMOKE_TOKEN

step "create the fixture skills through the REST API (as ${ADMIN_LOGIN})"
# The session cookie goes to the jar; mutations must carry Origin (the server checks it).
curl -fsS -o /dev/null -c "$COOKIE_JAR" -H "Origin: ${BASE_URL}" -H 'Content-Type: application/json' \
  --data "{\"login\":\"${ADMIN_LOGIN}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  "${BASE_URL}/api/auth/login" || fail "admin login failed"
for skill_dir in scripts/smoke-fixtures/*/; do
  skill_dir="${skill_dir%/}"
  slug="$(basename "$skill_dir")"
  # Multipart as the editor sends it: the slug field, then one part per file named by its path.
  form=(-F "slug=${slug}" -F folder=general)
  while IFS= read -r -d '' file; do
    form+=(-F "${file#"$skill_dir"/}=@${file}")
  done < <(find "$skill_dir" -type f -print0)
  status="$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H "Origin: ${BASE_URL}" \
    "${form[@]}" "${BASE_URL}/api/skills")"
  [ "$status" = "201" ] || fail "POST /api/skills for ${slug} returned HTTP ${status}"
  echo "created: ${slug}"
done

step "MCP search_skills / get_skill (up to ${SEARCH_TIMEOUT}s while the outbox indexes)"
# Russian queries against English fixtures check the multilingual model end to end:
# "ревью кода" = "code review", "заполнить PDF-форму" = "fill in a PDF form",
# "рецепт борща" = "borscht recipe" (unrelated, must find nothing).
deadline=$((SECONDS + SEARCH_TIMEOUT))
until node scripts/smoke-mcp.mjs "$BASE_URL" "ревью кода" code-review; do
  [ "$SECONDS" -lt "$deadline" ] || fail "search_skills did not find code-review"
  sleep 3
done

step "embeddings stored by the in-container model (up to ${SEARCH_TIMEOUT}s)"
# Search can already find one skill while the outbox is still embedding the other.
deadline=$((SECONDS + SEARCH_TIMEOUT))
until embedded="$(compose exec -T db psql -U skills -d skills -tAc \
  'select count(*) from search.documents where embedding is not null')" && [ "$embedded" = "2" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail "expected 2 documents with embeddings, got ${embedded}"
  sleep 3
done
echo "documents with embeddings: ${embedded}"

step "relevance: a contrasting query ranks the other skill first, an unrelated one finds nothing"
node scripts/smoke-mcp.mjs "$BASE_URL" "заполнить PDF-форму" pdf-forms ||
  fail "search_skills did not rank pdf-forms first"
node scripts/smoke-mcp.mjs "$BASE_URL" "рецепт борща" - ||
  fail "search_skills returned results for an unrelated query"
