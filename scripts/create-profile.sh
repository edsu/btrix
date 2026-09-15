#!/bin/bash
# usage: create-profile.sh <start-url> <profiles-dir> [profile-name]
#
# Opens an interactive browser, served over noVNC at http://localhost:6080, so a
# person can log in to a site by hand. The resulting profile is written to
# <profiles-dir>/<name>.tar.gz and referenced from a crawl config as:
#
#   profile: /crawls/profiles/<name>.tar.gz
#
# The login is done by the person, in that browser. Nothing here takes, stores
# or forwards credentials, and profiles/*.tar.gz hold session cookies, so they
# are kept out of version control by the store's own .gitignore.
#
# Both ports are published on 127.0.0.1 rather than 0.0.0.0. A bare
# `-p 6080:6080` would put this unauthenticated noVNC session -- the one a
# password and 2FA code get typed into -- on every interface, so anyone on the
# same network could watch and drive it. 9223 is the profile browser's own
# control port, which is worse: it hands over the authenticated session.

set -euo pipefail

url="${1:-}"
profiles_dir="${2:-}"
name="${3:-profile}"

if [ -z "$url" ] || [ -z "$profiles_dir" ]; then
  echo "usage: create-profile.sh <start-url> <profiles-dir> [profile-name]" >&2
  exit 2
fi

mkdir -p "$profiles_dir"

if command -v podman >/dev/null 2>&1; then
  engine=podman
elif command -v docker >/dev/null 2>&1; then
  engine=docker
else
  echo "please install docker or podman" >&2
  exit 1
fi

"$engine" pull "webrecorder/browsertrix-crawler:${BTRIX_CRAWLER_VERSION:-latest}"

exec "$engine" run \
  -p 127.0.0.1:6080:6080 \
  -p 127.0.0.1:9223:9223 \
  --rm \
  -v "$profiles_dir":/crawls/profiles/ \
  "webrecorder/browsertrix-crawler:${BTRIX_CRAWLER_VERSION:-latest}" \
  create-login-profile \
  --url "$url" \
  --filename "/crawls/profiles/$name.tar.gz"
