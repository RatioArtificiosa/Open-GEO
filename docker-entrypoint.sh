#!/bin/sh
# Self-host container entrypoint. vite build inlines the envPrefix'd client
# envs (see vite.config.ts) into the bundle, so the build must run at container
# start — but the output stays valid until those envs or the image change.
# Fingerprint them and skip the build when the last start's output matches; an
# image update lands a fresh container with no build output, so new code always
# rebuilds.
set -e

echo 'OpenGeo sends an anonymous usage heartbeat (counts only). Disable: OPENGEO_TELEMETRY_DISABLED=1. Details: docs/SELF_HOSTING_DOCKER.md#telemetry'

# The preflight validates env BEFORE the slow steps, so misconfiguration fails
# in seconds with the exact fix instead of after a multi-minute build.
pnpm exec tsx scripts/selfhost-preflight.ts

# ── Migrations, on whichever backend is configured ──────────────────────────
#
# `DATABASE_PROVIDER` selects the dialect, the same variable `src/db/provider.ts`
# reads at runtime. The default is D1, which needs no URL because Wrangler binds it
# locally.
#
# **The Postgres path was missing entirely.** A self-hoster on the hosted stack had
# to exec into the container and run migrations by hand — or the container served a
# schema 38 migrations behind the code, which reads as broken features rather than as
# a missing migration.
#
# **Postgres needs a HYPERDRIVE binding, not a DATABASE_URL.** The provider reads the
# connection string from the binding's `connectionString`, and in local dev from its
# `localConnectionString`. See docs/SELF_HOSTING_DOCKER.md#using-postgres-instead-of-d1
# for the two files a self-hoster edits; the preflight below reports it as a hard
# failure when the binding is absent, because `db:migrate:pg` would otherwise fail on
# a missing `DATABASE_URL` in drizzle-pg.config.ts after a multi-minute build.
#
# `db:migrate:pg` is idempotent — drizzle tracks applied migrations in its own table,
# so re-running it on an already-migrated database is a no-op.
if [ "${DATABASE_PROVIDER:-d1}" = "postgres" ]; then
  echo 'Migrating Postgres (DATABASE_PROVIDER=postgres)...'
  pnpm run db:migrate:pg
else
  echo 'Migrating D1 (DATABASE_PROVIDER=d1)...'
  pnpm run db:migrate:local
fi

# POSTHOG_SOURCEMAPS (CI sourcemap uploads) moves vite's outDir; keep the
# fingerprint marker beside the output it describes.
if [ "${POSTHOG_SOURCEMAPS:-}" = "true" ]; then OUT_DIR=dist-sourcemaps; else OUT_DIR=dist; fi
FP_FILE="$OUT_DIR/.opengeo-build-env"

# Everything that changes build output: the envPrefix prefixes from
# vite.config.ts (keep in sync) plus POSTHOG_SOURCEMAPS.
FINGERPRINT="$(env | grep -E '^(VITE_|AUTH_MODE|BYPASS_EMAIL_VERIFICATION|POSTHOG_PUBLIC_KEY|POSTHOG_HOST|TURNSTILE_SITE_KEY|POSTHOG_SOURCEMAPS)' | sort | sha256sum | cut -d' ' -f1)"
# A missing sha256sum would yield an empty, always-matching fingerprint and
# silently disable rebuilds — fail loudly instead.
test -n "$FINGERPRINT"

if [ -f "$FP_FILE" ] && [ "$(cat "$FP_FILE")" = "$FINGERPRINT" ]; then
  echo "Reusing existing build (build-relevant env unchanged)."
else
  echo "Building client + server (first start, changed build env, or new image)..."
  rm -f "$FP_FILE"
  pnpm run build
  printf '%s' "$FINGERPRINT" > "$FP_FILE"
fi

exec pnpm exec vite preview --host 0.0.0.0 --port "${PORT:-3001}"
