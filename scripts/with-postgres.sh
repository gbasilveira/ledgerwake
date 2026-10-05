#!/usr/bin/env bash
# Usage: scripts/with-postgres.sh <command...>
# Runs <command> with LW_TEST_DATABASE_URL pointing at a throw-away PostgreSQL container, then
# removes the container. Rootless podman (or docker if podman is absent); the database listens on
# 127.0.0.1 only, on a free port, with a random password that never leaves this process.
set -euo pipefail
engine="$(command -v podman || command -v docker || true)"
[ -n "$engine" ] || { echo "needs podman or docker" >&2; exit 2; }
image="${LW_POSTGRES_IMAGE:-docker.io/library/postgres:17-alpine}"
name="lw-pg-test-$$"
password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$engine" run -d --rm --name "$name" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=ledgerwake \
  -p "127.0.0.1:$port:5432" "$image" >/dev/null 2>&1
for _ in $(seq 60); do
  if "$engine" exec "$name" pg_isready -U postgres -d ledgerwake >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "${ready:-0}" = 1 ] || { echo "PostgreSQL did not become ready" >&2; exit 3; }
# pg_isready answers during initialisation; wait until a real query works on the final server.
for _ in $(seq 30); do
  if "$engine" exec "$name" psql -U postgres -d ledgerwake -tAc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
sleep 2
export LW_TEST_DATABASE_URL="postgres://postgres:$password@127.0.0.1:$port/ledgerwake"
"$@"
