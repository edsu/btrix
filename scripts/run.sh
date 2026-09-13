#!/bin/bash
# usage: run.sh <config-name>
#
# Runs a Browsertrix Crawler crawl for ./config/<config-name>.yaml, mounting the
# current directory into the container so output lands in ./collections/.
#
# Kept as shell on purpose: the whole job is picking an engine and assembling
# flags, and a shell script stays copy-pasteable when you need to run a crawl by
# hand. The parsing and rendering live in TypeScript, where they earn it.
#
# Differences from the browsertrix-crawler-claude version: no TTY branch and no
# browser popup. btrix spawns this detached and surfaces the screencast URL in
# the TUI widget instead.

set -euo pipefail

VERSION="${BTRIX_CRAWLER_VERSION:-latest}"
name="${1:-}"

if [ -z "$name" ]; then
  echo "usage: run.sh <config-name>" >&2
  exit 2
fi

if [ ! -f "config/$name.yaml" ] && [ ! -f "config/$name.yml" ]; then
  echo "no config/$name.yaml in $PWD" >&2
  exit 2
fi

config="config/$name.yaml"
[ -f "$config" ] || config="config/$name.yml"

if command -v podman >/dev/null 2>&1; then
  engine=podman
elif command -v docker >/dev/null 2>&1; then
  engine=docker
else
  echo "please install docker or podman" >&2
  exit 1
fi

"$engine" pull "webrecorder/browsertrix-crawler:$VERSION"

exec "$engine" run \
  -p 9037:9037 \
  --rm \
  -v "$PWD":/crawls/ \
  "webrecorder/browsertrix-crawler:$VERSION" \
  crawl --config "/crawls/$config"
