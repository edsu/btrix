#!/bin/bash
# usage: run.sh <config-name> <run-dir> [profiles-dir]
#
# Runs a Browsertrix Crawler crawl for <run-dir>/config/<config-name>.yaml,
# mounting <run-dir> at /crawls so all output lands inside it.
#
# A profiles directory, when given, is mounted read-only at /crawls/profiles so
# that a config saying `profile: /crawls/profiles/<name>.tar.gz` resolves. It is
# mounted rather than copied because profile tarballs are large, and read-only
# because a crawl has no business modifying a credential.
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
profiles_dir="${3:-}"

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

profile_mount=()
if [ -n "$profiles_dir" ] && [ -d "$profiles_dir" ]; then
  profile_mount=(-v "$profiles_dir":/crawls/profiles/:ro)
fi

exec "$engine" run \
  -p 9037:9037 \
  --rm \
  -v "$run_dir":/crawls/ \
  "${profile_mount[@]}" \
  "webrecorder/browsertrix-crawler:$VERSION" \
  crawl --config "/crawls/$config"
