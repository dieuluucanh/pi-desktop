#!/usr/bin/env bash
# Retry electron-builder with a longer horizon and a clean output directory.
#
#   PACKAGE_RETRY_ATTEMPTS=3 PACKAGE_RETRY_DELAY_SECONDS=60 \
#     scripts/package-retry.sh npx electron-builder --win --x64 --publish never
#
# electron-builder already retries its own downloads for ~12 s (2 s + 4 s + 6 s)
# before failing. A GitHub/electron-builder-binaries 504 can outlast that, so a
# failed attempt is retried after 60 s, then after 120 s. `release/` is removed
# before every attempt so a partial unpack cannot confuse the next one; check
# `RELEASE_...` artefacts only after the script succeeds.
#
# The command and the exit status of the final attempt are preserved, so the
# release job fails exactly as it would without the wrapper.

set -uo pipefail

attempts="${PACKAGE_RETRY_ATTEMPTS:-3}"
delay="${PACKAGE_RETRY_DELAY_SECONDS:-60}"
# The target is explicit so a test or local run cannot wipe an unrelated
# `release` directory by accident; CI uses the default at the repository root.
release_dir="${PACKAGE_RETRY_RELEASE_DIR:-release}"

case "$attempts" in '' | *[!0-9]*)
  echo "package-retry: PACKAGE_RETRY_ATTEMPTS must be a positive integer" >&2
  exit 2
  ;;
esac
case "$delay" in '' | *[!0-9]*)
  echo "package-retry: PACKAGE_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
  ;;
esac
[ "$attempts" -ge 1 ] || {
  echo "package-retry: PACKAGE_RETRY_ATTEMPTS must be at least 1" >&2
  exit 2
}
[ "$#" -ge 1 ] || {
  echo "usage: package-retry.sh <command...>" >&2
  exit 2
}

attempt=1
while true; do
  # A failed electron-builder run can leave a half-unpacked app; start clean.
  rm -rf "$release_dir" || true

  echo "::group::package attempt $attempt/$attempts: $*"
  if "$@"; then
    status=0
  else
    status=$?
  fi
  echo "::endgroup::"

  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "package-retry: '$*' failed after $attempt attempt(s) (exit $status)" >&2
    exit "$status"
  fi

  wait_seconds=$((delay * attempt))
  echo "package-retry: attempt $attempt/$attempts failed (exit $status); cleaning release/ and retrying in ${wait_seconds}s" >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
