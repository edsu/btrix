#!/bin/bash
# usage: run.sh <config-name> <run-dir>
#
# Runs a Browsertrix Crawler crawl for <run-dir>/config/<config-name>.yaml,
# mounting <run-dir> at /crawls so all output lands inside it.
#
# Each crawl attempt gets its own run directory with a copy of the config that
# produced it, which is both how the config becomes visible inside the
# container and how the run stays self-describing.
#
# Kept as shell on purpose: the whole job is picking an engine and assembling
# flags, and a shell script stays copy-pasteable when you need to run a crawl
# by hand. The parsing and rendering live in TypeScript, where they earn it.
#
# No TTY branch and no browser popup: btrix spawns this detached and surfaces
# the screencast URL in the TUI widget instead.

set -euo pipefail

VERSION="${BTRIX_CRAWLER_VERSION:-latest}"
name="${1:-}"
run_dir="${2:-}"

if [ -z "$name" ] || [ -z "$run_dir" ]; then
  echo "usage: run.sh <config-name> <run-dir>" >&2
  exit 2
fi

if [ ! -d "$run_dir" ]; then
  echo "no such run directory: $run_dir" >&2
  exit 2
fi

config="config/$name.yaml"
if [ ! -f "$run_dir/$config" ]; then
  config="config/$name.yml"
fi
if [ ! -f "$run_dir/$config" ]; then
  echo "no config/$name.yaml in $run_dir" >&2
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

"$engine" pull "webrecorder/browsertrix-crawler:$VERSION"

exec "$engine" run \
  -p 9037:9037 \
  --rm \
  -v "$run_dir":/crawls/ \
  "webrecorder/browsertrix-crawler:$VERSION" \
  crawl --config "/crawls/$config"
