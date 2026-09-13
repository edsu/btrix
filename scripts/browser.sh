#!/bin/bash
# usage: browser.sh <container-name> <start-url>
#
# Starts a real Chrome in the crawler image and leaves it on a page, for trying
# selectors and interaction code while writing a custom behavior.
#
# It uses the image's create-login-profile command, which is the one entry point
# that opens a browser and waits rather than crawling and exiting. The profile
# filename points into the container's own /tmp and is never saved, so nothing
# is written to the store: this is a scratch browser, not a profile capture.
#
# noVNC is published on 6080 so the page can be watched and clicked. Chrome's
# DevTools port is deliberately not published: it binds to loopback inside the
# container, so btrix talks to it with `exec` from inside instead.

set -euo pipefail

name="${1:-}"
url="${2:-}"

if [ -z "$name" ] || [ -z "$url" ]; then
  echo "usage: browser.sh <container-name> <start-url>" >&2
  exit 2
fi

if command -v podman >/dev/null 2>&1; then
  engine=podman
elif command -v docker >/dev/null 2>&1; then
  engine=docker
else
  echo "please install docker or podman" >&2
  exit 1
fi

exec "$engine" run \
  --rm \
  --name "$name" \
  -p 6080:6080 \
  "webrecorder/browsertrix-crawler:${BTRIX_CRAWLER_VERSION:-latest}" \
  create-login-profile \
  --url "$url" \
  --filename /tmp/btrix-scratch-profile.tar.gz
