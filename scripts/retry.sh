#!/usr/bin/env bash
# Bounded retry for a release command.
#
#   scripts/retry.sh <attempts> <delay-seconds> -- <command...>
#
# The delay grows linearly (delay, 2×delay, …) so a 5xx that lasts longer than
# electron-builder's built-in ~12 s retry still gets a chance after the upstream
# edge has recovered. The exit status of the last attempt is preserved; a
# non-zero exit here means every attempt failed.
#
# Kept dependency-free on purpose: this runs in Git Bash on the Windows runner
# as well as bash on Linux/macOS. Use package-retry.sh when the command is
# electron-builder and `release/` must be cleaned between attempts.

set -uo pipefail

usage() {
  echo "usage: retry.sh <attempts> <delay-seconds> -- <command...>" >&2
  exit 2
}

[ "$#" -ge 4 ] || usage
attempts=$1
delay=$2
[ "$3" = "--" ] || usage
shift 3

case "$attempts" in '' | *[!0-9]*) usage ;; esac
case "$delay" in '' | *[!0-9]*) usage ;; esac
[ "$attempts" -ge 1 ] || usage

attempt=1
while true; do
  echo "::group::attempt $attempt/$attempts: $*"
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
    echo "retry: '$*' failed after $attempt attempt(s) (exit $status)" >&2
    exit "$status"
  fi

  wait_seconds=$((delay * attempt))
  echo "retry: attempt $attempt/$attempts failed (exit $status); retrying in ${wait_seconds}s" >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
